const crypto = require("crypto");
const { availableSlotList } = require("./calendar-slots");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freeBusy";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events"
];

const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function cleanUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function getRedirectUri() {
  return cleanUrl(process.env.GOOGLE_CALENDAR_REDIRECT_URI)
    || (cleanUrl(process.env.PUBLIC_APP_URL) + "/api/google-calendar/callback");
}

function getConfig() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
    redirectUri: getRedirectUri(),
    calendarId: String(process.env.GOOGLE_CALENDAR_ID || "primary").trim() || "primary"
  };
}

function secretKey() {
  return crypto.createHash("sha256")
    .update(String(process.env.JML_CALENDAR_TOKEN_SECRET || process.env.JML_ADMIN_PASSWORD || ""))
    .digest();
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(x => x.toString("base64url")).join(".");
}

function decrypt(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("Token calendrier invalide.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(parts[0], "base64url")
  );
  decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[2], "base64url")),
    decipher.final()
  ]).toString("utf8");
}

async function ensureTable(pool) {
  if (!pool) return;
  await pool.query("ALTER TABLE jml_appointment_requests ADD COLUMN IF NOT EXISTS calendar_event_id TEXT");
  await pool.query("ALTER TABLE jml_appointment_requests ADD COLUMN IF NOT EXISTS response_token TEXT");
  await pool.query("ALTER TABLE jml_appointment_requests ADD COLUMN IF NOT EXISTS proposed_slots JSONB");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jml_google_calendar_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      refresh_token TEXT NOT NULL,
      calendar_id TEXT NOT NULL DEFAULT 'primary',
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function loadRefreshToken(pool) {
  if (!pool) return null;
  await ensureTable(pool);
  const q = await pool.query(
    "SELECT refresh_token, calendar_id FROM jml_google_calendar_tokens WHERE id=1 LIMIT 1"
  );
  if (!q.rowCount) return null;
  return {
    refreshToken: decrypt(q.rows[0].refresh_token),
    calendarId: q.rows[0].calendar_id || "primary"
  };
}

async function exchangeCode(config, code) {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Google OAuth token exchange HTTP " + response.status + ": " + (payload.error_description || payload.error || "unknown"));
  }
  return payload;
}

async function refreshAccessToken(config, refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token"
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Google token refresh HTTP " + response.status + ": " + (payload.error_description || payload.error || "unknown"));
  }
  return payload;
}

async function getAccessToken(pool) {
  const config = getConfig();
  if (!config.clientId || !config.clientSecret) {
    throw new Error("Google Calendar OAuth non configuré dans Render.");
  }
  const saved = await loadRefreshToken(pool);
  if (!saved?.refreshToken) {
    throw new Error("Google Calendar non autorisé.");
  }
  const payload = await refreshAccessToken(config, saved.refreshToken);
  if (!payload.access_token) throw new Error("Google n'a pas fourni de jeton d'accès.");
  return {
    accessToken: payload.access_token,
    calendarId: saved.calendarId || config.calendarId
  };
}

async function getGoogleCalendarBusy(pool, start, end) {
  const startDate = start instanceof Date ? start : new Date(start);
  const endDate = end instanceof Date ? end : new Date(end);
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || endDate <= startDate) {
    throw new Error("Période Google Calendar invalide.");
  }
  const token = await getAccessToken(pool);
  const response = await fetch(FREEBUSY_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token.accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      timeZone: "Europe/Paris",
      items: [{ id: token.calendarId || "primary" }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Google freebusy HTTP " + response.status + ": " + (payload.error?.message || "unknown"));
  }
  const calendar = payload?.calendars?.[token.calendarId || "primary"] || {};
  if (Array.isArray(calendar.errors) && calendar.errors.length) {
    throw new Error("Google Calendar : disponibilité indisponible.");
  }
  return Array.isArray(calendar.busy) ? calendar.busy : [];
}

function requireConfigured(res) {
  const config = getConfig();
  if (!config.clientId || !config.clientSecret || !config.redirectUri) {
    res.status(503).json({
      ok: false,
      code: "JML-CAL-001",
      error: "Google Calendar n'est pas encore configuré dans Render."
    });
    return null;
  }
  return config;
}

async function createGoogleCalendarEvent(pool, { start, end, summary, description, location }) {
  const token = await getAccessToken(pool);
  const calendarId = encodeURIComponent(token.calendarId || "primary");
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/" + calendarId + "/events", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token.accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      summary: String(summary || "Rendez-vous vendeur JML"),
      description: String(description || ""),
      location: String(location || ""),
      start: { dateTime: new Date(start).toISOString(), timeZone: "Europe/Paris" },
      end: { dateTime: new Date(end).toISOString(), timeZone: "Europe/Paris" },
      status: "confirmed"
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("Google Calendar event HTTP " + response.status + ": " + (payload.error?.message || "unknown"));
  return payload;
}

async function deleteGoogleCalendarEvent(pool, eventId) {
  if (!eventId) return;
  const token = await getAccessToken(pool);
  const calendarId = encodeURIComponent(token.calendarId || "primary");
  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/" + calendarId + "/events/" + encodeURIComponent(eventId), {
    method: "DELETE",
    headers: { "Authorization": "Bearer " + token.accessToken }
  });
  if (!response.ok && response.status !== 404) {
    const payload = await response.json().catch(() => ({}));
    throw new Error("Google Calendar event delete HTTP " + response.status + ": " + (payload.error?.message || "unknown"));
  }
}

async function sendResendMail(to, subject, text, html) {
  const apiKey=String(process.env.RESEND_API_KEY||"").trim();
  const from=String(process.env.RESEND_FROM||"").trim();
  if(!to||!apiKey||!from) return false;
  const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},body:JSON.stringify({from,to:[to],subject,text,html})});
  if(!response.ok) throw new Error("Resend "+response.status);
  return true;
}

async function getBookedAppointmentTimes(pool) {
  if (!pool) return [];
  const q = await pool.query(`SELECT requested_at FROM jml_appointment_requests WHERE status='À traiter' UNION ALL SELECT appointment_at AS requested_at FROM jml_activities WHERE outcome='RDV pris' AND appointment_at IS NOT NULL`);
  return q.rows.map(r => new Date(r.requested_at).getTime()).filter(Number.isFinite);
}

async function syncConfirmedAppointments(pool) {
  if (!pool) return;
  try {
    await pool.query("UPDATE jml_appointment_requests SET response_token=md5(random()::text || clock_timestamp()::text) WHERE response_token IS NULL AND status IN ('À traiter','À revoir')");
    const q=await pool.query("SELECT id,name,email,phone,requested_at,requested_location,calendar_event_id FROM jml_appointment_requests WHERE status='Confirmée' AND calendar_event_id IS NULL AND requested_at IS NOT NULL ORDER BY requested_at LIMIT 10");
    for (const r of q.rows) {
      const start=new Date(r.requested_at), end=new Date(start.getTime()+60*60*1000);
      if(!Number.isFinite(start.getTime())) continue;
      const busy=await getGoogleCalendarBusy(pool,start,end);
      if(busy.some(x=>new Date(x.start)<end&&new Date(x.end)>start)) continue;
      const event=await createGoogleCalendarEvent(pool,{start,end,summary:"Rendez-vous vendeur — "+String(r.name||"Prospect"),description:"Rendez-vous confirmé avec JML Immobilier."+(r.email?"\nE-mail : "+r.email:"")+(r.phone?"\nTéléphone : "+r.phone:""),location:r.requested_location||""});
      if(event?.id) await pool.query("UPDATE jml_appointment_requests SET calendar_event_id=$2 WHERE id=$1",[r.id,event.id]);
    }

    const rejected=await pool.query("SELECT id,name,email,response_token FROM jml_appointment_requests WHERE status='À revoir' AND email IS NOT NULL AND response_token IS NOT NULL AND (proposed_slots IS NULL OR jsonb_array_length(proposed_slots)=0) ORDER BY created_at LIMIT 5");
    for(const r of rejected.rows){
      const slots=availableSlotList(await getBookedAppointmentTimes(pool),await getGoogleCalendarBusy(pool,new Date(),new Date(Date.now()+31*24*60*60*1000))).slice(0,4);
      if(!slots.length) continue;
      await pool.query("UPDATE jml_appointment_requests SET status='Proposée',proposed_slots=$2 WHERE id=$1",[r.id,JSON.stringify(slots)]);
      const base=(process.env.PUBLIC_APP_URL||"").replace(/\/$/,"");
      const links=slots.map((x,i)=>base+"/api/appointment-requests/"+encodeURIComponent(r.id)+"/accept?token="+encodeURIComponent(r.response_token)+"&slot="+encodeURIComponent(x));
      const text="Bonjour "+String(r.name||"").split(/\s+/)[0]+",\n\nLe créneau demandé n'est plus disponible. Voici mes possibilités :\n\n"+slots.map((x,i)=>(i+1)+". "+new Date(x).toLocaleString("fr-FR",{dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"})).join("\n")+"\n\nChoisissez directement le créneau qui vous convient :\n"+links.map((x,i)=>(i+1)+". "+x).join("\n")+"\n\nJML Immobilier";
      const html="<p>Bonjour "+String(r.name||"").split(/\s+/)[0]+",</p><p>Le créneau demandé n'est plus disponible. Voici mes possibilités :</p><ol>"+slots.map((x,i)=>"<li><a href=\""+links[i]+"\">"+new Date(x).toLocaleString("fr-FR",{dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"})+"</a></li>").join("")+"</ol><p>JML Immobilier</p>";
      await sendResendMail(r.email,"Choisissez votre nouveau créneau — JML Immobilier",text,html);
    }
  } catch(error) {
    console.warn("JML Calendar sync:",error?.message||error);
  }
}

async function registerGoogleCalendarRoutes(app, options) {
  const pool = options?.pool || null;
  const isAdminAuthenticated = options?.isAdminAuthenticated || (() => false);
  app.get("/api/appointment-requests/:id/accept", async (req, res) => {
    if (!pool) return res.status(503).send("Calendrier indisponible.");
    try {
      const q = await pool.query(
        "SELECT * FROM jml_appointment_requests WHERE id=$1 AND response_token=$2 LIMIT 1",
        [String(req.params.id || ""), String(req.query.token || "")]
      );
      if (!q.rowCount) return res.status(404).send("Lien invalide.");
      const r = q.rows[0];
      const slot = new Date(String(req.query.slot || ""));
      if (r.status !== "Proposée" || !Array.isArray(r.proposed_slots) || !r.proposed_slots.includes(slot.toISOString())) {
        return res.status(409).send("Ce créneau n'est plus disponible.");
      }
      const end = new Date(slot.getTime() + 60 * 60 * 1000);
      const busy = await getGoogleCalendarBusy(pool, slot, end);
      if (busy.some(x => new Date(x.start) < end && new Date(x.end) > slot)) {
        return res.status(409).send("Ce créneau vient d'être pris.");
      }
      const event = await createGoogleCalendarEvent(pool, {
        start: slot,
        end,
        summary: "Rendez-vous vendeur — " + String(r.name || "Prospect"),
        location: r.requested_location || "",
        description: "Rendez-vous confirmé avec JML Immobilier."
      });
      await pool.query(
        "UPDATE jml_appointment_requests SET status='Confirmée',requested_at=$2,calendar_event_id=$3 WHERE id=$1",
        [r.id, slot, event.id]
      );
      if (r.prospect_id) {
        await pool.query(
          "INSERT INTO jml_activities (id,prospect_id,type,note,outcome,appointment_at,appointment_location,created_at) VALUES ($1,$2,'RDV',$3,'RDV pris',$4,$5,NOW())",
          [crypto.randomUUID(), r.prospect_id, "Rendez-vous confirmé par le vendeur.", slot, r.requested_location || null]
        );
      }
      await sendResendMail(
        r.email,
        "Rendez-vous confirmé — JML Immobilier",
        "Votre rendez-vous est confirmé le " + slot.toLocaleString("fr-FR", {dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"}) + ".",
        "<p>Votre rendez-vous est confirmé.</p><p>" + slot.toLocaleString("fr-FR", {dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"}) + "</p><p>JML Immobilier</p>"
      );
      return res.send("Rendez-vous confirmé avec JML Immobilier.");
    } catch (error) {
      console.error("JML appointment acceptance:", error);
      return res.status(500).send("Impossible de confirmer ce rendez-vous.");
    }
  });


  // Enregistrer les routes immédiatement. Ne pas attendre PostgreSQL ici :
  // Render doit pouvoir exposer /api/google-calendar/auth dès le démarrage.
  app.get("/api/google-calendar/auth", (req, res) => {
    if (!isAdminAuthenticated(req)) {
      return res.status(401).json({ ok: false, code: "JML-CAL-002", error: "Authentification professionnelle requise." });
    }
    const config = requireConfigured(res);
    if (!config) return;

    const state = crypto.randomBytes(32).toString("hex");
    pendingStates.set(state, { createdAt: Date.now() });

    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);

    res.redirect(302, url.toString());
  });

  app.get("/api/google-calendar/callback", async (req, res) => {
    const state = String(req.query.state || "");
    const pending = pendingStates.get(state);
    pendingStates.delete(state);

    if (!pending || Date.now() - pending.createdAt > STATE_TTL_MS) {
      return res.status(400).send("Autorisation Google expirée. Relancez la connexion depuis JML.");
    }
    if (req.query.error) {
      return res.status(400).send("Google a refusé ou annulé l'autorisation.");
    }

    const config = getConfig();
    if (!config.clientId || !config.clientSecret) {
      return res.status(503).send("Google Calendar n'est pas configuré dans Render.");
    }

    try {
      const payload = await exchangeCode(config, String(req.query.code || ""));
      if (!payload.refresh_token) {
        throw new Error("Google n'a pas fourni de refresh token. Relancez l'autorisation.");
      }
      if (!pool) throw new Error("PostgreSQL est nécessaire pour conserver l'autorisation Google.");
      await ensureTable(pool);
      await pool.query(
        `INSERT INTO jml_google_calendar_tokens (id, refresh_token, calendar_id, scope, updated_at)
         VALUES (1,$1,$2,$3,NOW())
         ON CONFLICT (id) DO UPDATE SET refresh_token=EXCLUDED.refresh_token,
           calendar_id=EXCLUDED.calendar_id, scope=EXCLUDED.scope, updated_at=NOW()`,
        [encrypt(payload.refresh_token), config.calendarId, payload.scope || SCOPES.join(" ")]
      );
      res.send("<h2>Google Calendar est connecté à JML.</h2><p>Tu peux fermer cette fenêtre et revenir à ton espace professionnel.</p>");
    } catch (error) {
      console.error("JML Google Calendar OAuth callback:", error);
      res.status(500).send("Connexion Google Calendar impossible. Consulte les logs Render.");
    }
  });

  app.post("/api/google-calendar/disconnect", async (req, res) => {
    if (!isAdminAuthenticated(req)) {
      return res.status(401).json({ ok: false, code: "JML-CAL-002", error: "Authentification professionnelle requise." });
    }
    try {
      await ensureTable(pool);
      await pool.query("DELETE FROM jml_google_calendar_tokens WHERE id=1");
      return res.json({ ok: true, connected: false });
    } catch (error) {
      console.error("JML Google Calendar disconnect:", error);
      return res.status(500).json({ ok: false, code: "JML-CAL-007", error: "Déconnexion Google Calendar impossible." });
    }
  });

  app.get("/api/google-calendar/status", async (req, res) => {
    if (!isAdminAuthenticated(req)) {
      return res.status(401).json({ ok: false, code: "JML-CAL-002", error: "Authentification professionnelle requise." });
    }
    try {
      const config = getConfig();
      const saved = await loadRefreshToken(pool);
      res.json({
        ok: true,
        configured: Boolean(config.clientId && config.clientSecret && config.redirectUri),
        connected: Boolean(saved?.refreshToken),
        calendarId: saved?.calendarId || config.calendarId || "primary"
      });
    } catch (error) {
      res.status(503).json({ ok: false, code: "JML-CAL-003", error: "Statut Google Calendar indisponible." });
    }
  });

  app.get("/api/google-calendar/availability", async (req, res) => {
    try {
      const config = requireConfigured(res);
      if (!config) return;

      const start = new Date(String(req.query.start || ""));
      const end = new Date(String(req.query.end || ""));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
        return res.status(400).json({ ok: false, code: "JML-CAL-004", error: "Période invalide." });
      }

      const maxRangeMs = 31 * 24 * 60 * 60 * 1000;
      if (end.getTime() - start.getTime() > maxRangeMs) {
        return res.status(400).json({ ok: false, code: "JML-CAL-005", error: "Période trop longue." });
      }

      const busy = await getGoogleCalendarBusy(pool, start, end);
      const saved = await loadRefreshToken(pool);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        calendarId: saved?.calendarId || config.calendarId || "primary",
        busy
      });
    } catch (error) {
      const message = String(error?.message || error);
      const status = /non autorisé|non configuré|non configurée|OAuth/i.test(message) ? 503 : 500;
      res.status(status).json({ ok: false, code: "JML-CAL-006", error: message });
    }
  });

  // Initialiser la table en arrière-plan après l'enregistrement des routes.
  // Les routes qui utilisent PostgreSQL appellent déjà ensureTable() au besoin.
  try {
    await ensureTable(pool);
    if (pool) {
      await syncConfirmedAppointments(pool);
      setInterval(() => syncConfirmedAppointments(pool), 30000);
    }
  } catch (error) {
    console.warn("JML Google Calendar table:", error.message);
  }
}

module.exports = { registerGoogleCalendarRoutes, getGoogleCalendarBusy, createGoogleCalendarEvent, deleteGoogleCalendarEvent, SCOPES };
