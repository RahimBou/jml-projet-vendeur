const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const file = path.join(__dirname, "data", "encyclopedia.json.gz.b64");
let cache;
function items() {
  if (cache) return cache;
  try {
    const b64 = fs.readFileSync(file, "utf8").trim();
    cache = JSON.parse(zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8")).items;
  } catch (e) {
    console.error("Encyclopédie indisponible:", e.message);
    cache = [];
  }
  return cache;
}
function norm(s) { return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim(); }
module.exports = function registerEncyclopediaRoutes(app) {
  app.get("/api/encyclopedia", (req, res) => {
    const all = items();
    const q = norm(req.query.q), category = norm(req.query.category), scope = norm(req.query.appliesTo);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const found = all.filter(x =>
      (!category || norm(x.category) === category) &&
      (!scope || scope === "all" || scope === "both" || norm(x.appliesTo) === scope || norm(x.appliesTo) === "both") &&
      (!q || [x.title, x.category, x.appliesTo, x.definition, x.slug].some(v => norm(v).includes(q)))
    ).slice(0, limit);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ ok: true, count: all.length, categories: [...new Set(all.map(x => x.category))].sort(), items: found,
      notice: "Catalogue explicatif uniquement; aucune incidence sur les calculs DVF/DPE. Le CSV source ne contient pas les articles complets, les mots-clés eux-mêmes ni les URL des sources." });
  });
  app.get("/api/encyclopedia/:slug", (req, res) => {
    const item = items().find(x => x.slug === req.params.slug);
    if (!item) return res.status(404).json({ ok: false, error: "Fiche introuvable." });
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ ok: true, item });
  });
};
