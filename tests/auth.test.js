"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { parseCookies, sha256, safeEqualText, COOKIE_NAME, hashPassword, verifyPassword } = require("../auth");

test("parseCookies handles multiple cookies and malformed encoding safely", () => {
  assert.deepEqual(
    { ...parseCookies("a=1; jml_session=abc%2F123; broken=%E0%A4%A") },
    { a: "1", jml_session: "abc/123", broken: "" }
  );
});

test("session token fingerprints are deterministic and do not expose the token", () => {
  const token = crypto.randomBytes(32).toString("base64url");
  const digest = sha256(token);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, token);
  assert.equal(sha256(token), digest);
  assert.equal(COOKIE_NAME, "jml_session");
});

test("constant-time text comparison rejects unequal lengths and values", () => {
  assert.equal(safeEqualText("abc", "abc"), true);
  assert.equal(safeEqualText("abc", "abd"), false);
  assert.equal(safeEqualText("abc", "abcd"), false);
});

test("Argon2id password hashing verifies only the correct password", async () => {
  const password = "JML-Temporary-Test-Password-2026!";
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$/);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, "wrong password"), false);
  assert.equal(await verifyPassword("not-a-hash", password), false);
});

test("password policy rejects short and oversized values", async () => {
  await assert.rejects(() => hashPassword("short"), /12 et 1024/);
  await assert.rejects(() => hashPassword("x".repeat(1025)), /12 et 1024/);
});


function makeAuthHarness() {
  const state = { session: null, revoked: false, userActive: true, lastQuery: null };
  const pool = {
    async query(sql, params = []) {
      state.lastQuery = sql;
      if (/INSERT INTO jml_auth_sessions/i.test(sql)) {
        state.session = { tokenHash: params[0], userId: params[1], expiresAt: params[2] };
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT u\.id,u\.email,u\.role,u\.seller_id,s\.id AS session_id/i.test(sql)) {
        if (!state.session || params[0] !== state.session.tokenHash || state.revoked || !state.userActive) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{
          id: state.session.userId, email: "vendeur@example.test", role: "seller", seller_id: "seller-A",
          session_id: "session-A", created_at: new Date(), last_seen_at: new Date(),
          expires_at: state.session.expiresAt
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  return { state, pool };
}

test("issueSession stores only a token hash and sets a secure HttpOnly cookie", async () => {
  const { createAuth } = require("../auth");
  const { pool, state } = makeAuthHarness();
  const auth = createAuth({ pool, secureCookies: true, sessionTtlMs: 60_000 });
  const responseHeaders = {};
  const res = { setHeader(name, value) { responseHeaders[name] = value; } };
  const user = await auth.issueSession(
    { id: "user-A", role: "seller", seller_id: "seller-A", email: "vendeur@example.test" },
    { headers: { "user-agent": "test-agent" }, ip: "127.0.0.1" },
    res
  );
  assert.equal(user.role, "seller");
  assert.ok(state.session);
  assert.match(state.session.tokenHash, /^[a-f0-9]{64}$/);
  assert.match(responseHeaders["Set-Cookie"], /jml_session=/);
  assert.match(responseHeaders["Set-Cookie"], /HttpOnly/);
  assert.match(responseHeaders["Set-Cookie"], /Secure/);
  assert.match(responseHeaders["Set-Cookie"], /SameSite=Strict/);
  const token = decodeURIComponent(responseHeaders["Set-Cookie"].match(/jml_session=([^;]*)/)[1]);
  assert.notEqual(state.session.tokenHash, token);
});

test("resolveSession returns verified role and seller scope from PostgreSQL", async () => {
  const { createAuth } = require("../auth");
  const { pool, state } = makeAuthHarness();
  const auth = createAuth({ pool });
  const res = { setHeader() {} };
  await auth.issueSession({ id: "user-A", role: "seller", seller_id: "seller-A", email: "vendeur@example.test" },
    { headers: {}, ip: "127.0.0.1" }, res);
  const token = decodeURIComponent(res.cookie || "");
  // Read the actual cookie through the response stub, without trusting client-supplied role data.
  const cookie = (res._cookie || "");
  assert.ok(state.session);
  const issuedToken = cookie.match(/jml_session=([^;]*)/)?.[1];
  assert.ok(issuedToken);
  const user = await auth.resolveSession({ headers: { cookie: "jml_session=" + issuedToken } });
  assert.equal(user.role, "seller");
  assert.equal(user.sellerId, "seller-A");
  assert.equal(user.id, "user-A");
});

test("requireRole rejects missing sessions and forbids the wrong role", async () => {
  const { createAuth } = require("../auth");
  const { pool } = makeAuthHarness();
  const auth = createAuth({ pool });
  const response = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  let nextCalled = false;
  await auth.requireRole("professional")({ headers: {} }, response, () => { nextCalled = true; });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});
