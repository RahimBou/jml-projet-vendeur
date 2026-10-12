"use strict";

const crypto = require("crypto");
const argon2 = require("argon2");

const COOKIE_NAME = "jml_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const IDLE_TTL_MS = 30 * 60 * 1000;
const TOKEN_BYTES = 32;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const cookies = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!Object.prototype.hasOwnProperty.call(cookies, name)) {
      try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = ""; }
    }
  }
  return cookies;
}

function setSessionCookie(res, token, { secure = true, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, { secure = true } = {}) {
  setSessionCookie(res, "", { secure, maxAgeSeconds: 0 });
}

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("Le mot de passe doit contenir entre 12 et 1024 caractères.");
  }
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

async function verifyPassword(hash, password) {
  if (!hash || typeof password !== "string" || password.length > 1024) return false;
  try { return await argon2.verify(hash, password, { type: argon2.argon2id }); }
  catch { return false; }
}

function createAuth({ pool, secureCookies = true, sessionTtlMs = SESSION_TTL_MS, idleTtlMs = IDLE_TTL_MS }) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("PostgreSQL requis pour les sessions sécurisées.");

  async function ensureSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jml_auth_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('professional','seller')),
        seller_id TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ,
        CONSTRAINT jml_auth_users_role_seller_check CHECK (
          (role = 'professional' AND seller_id IS NULL) OR
          (role = 'seller' AND seller_id IS NOT NULL)
        )
      )
    `);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS jml_auth_users_email_lower_uq ON jml_auth_users (LOWER(email))");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS jml_auth_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token_hash CHAR(64) NOT NULL UNIQUE,
        user_id UUID NOT NULL REFERENCES jml_auth_users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        user_agent_hash CHAR(64),
        ip_hash CHAR(64)
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS jml_auth_sessions_user_active_idx ON jml_auth_sessions (user_id, expires_at) WHERE revoked_at IS NULL");
    await pool.query("CREATE INDEX IF NOT EXISTS jml_auth_sessions_expiry_idx ON jml_auth_sessions (expires_at)");
  }

  async function issueSession(user, req, res) {
    const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    const expiresAt = new Date(now + sessionTtlMs);
    const userAgent = String(req.get?.("user-agent") || req.headers?.["user-agent"] || "").slice(0, 500);
    const ip = String(req.ip || req.socket?.remoteAddress || "").slice(0, 200);
    await pool.query(
      `INSERT INTO jml_auth_sessions (token_hash,user_id,expires_at,user_agent_hash,ip_hash)
       VALUES ($1,$2,$3,$4,$5)`,
      [sha256(rawToken), user.id, expiresAt, sha256(userAgent), sha256(ip)]
    );
    setSessionCookie(res, rawToken, { secure: secureCookies, maxAgeSeconds: Math.floor(sessionTtlMs / 1000) });
    return { id: user.id, role: user.role, sellerId: user.seller_id || null, email: user.email };
  }

  async function resolveSession(req, { touch = true } = {}) {
    const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
    if (!token || token.length > 200) return null;
    const result = await pool.query(
      `SELECT u.id,u.email,u.role,u.seller_id,s.id AS session_id,s.created_at,s.last_seen_at,s.expires_at
       FROM jml_auth_sessions s
       JOIN jml_auth_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND u.is_active=TRUE
         AND s.expires_at > NOW()
         AND s.last_seen_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
       LIMIT 1`,
      [sha256(token), idleTtlMs]
    );
    const user = result.rows[0];
    if (!user) return null;
    if (touch) {
      await pool.query("UPDATE jml_auth_sessions SET last_seen_at=NOW() WHERE id=$1", [user.session_id]);
    }
    return { id: user.id, role: user.role, sellerId: user.seller_id || null, email: user.email, sessionId: user.session_id };
  }

  async function revokeRequestSession(req, res) {
    const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
    if (token && token.length <= 200) {
      await pool.query("UPDATE jml_auth_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL", [sha256(token)]);
    }
    clearSessionCookie(res, { secure: secureCookies });
  }

  function requireRole(...roles) {
    return async (req, res, next) => {
      try {
        const user = await resolveSession(req);
        if (!user) return res.status(401).json({ ok: false, code: "AUTH_REQUIRED", error: "Authentification requise." });
        if (!roles.includes(user.role)) return res.status(403).json({ ok: false, code: "AUTH_FORBIDDEN", error: "Accès non autorisé." });
        req.auth = user;
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  return { ensureSchema, issueSession, resolveSession, revokeRequestSession, requireRole };
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_MS, IDLE_TTL_MS,
  createAuth, hashPassword, verifyPassword, parseCookies, sha256,
  safeEqualText, setSessionCookie, clearSessionCookie
};
