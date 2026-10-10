const SOURCE = "https://www.ardennes.com/preparer-son-sejour/agenda/";
let cache = { at: 0, events: [] };

function textOf(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function parseDate(value) {
  const m = String(value || "").match(/(\d{1,2})\s+(janv?\.?|févr?\.?|mars|avril|mai|juin|juil?\.?|août|sept?\.?|oct?\.?|nov?\.?|déc?\.?)\s+(\d{4})/i);
  if (!m) return null;
  const months = { janv:0, févr:1, mars:2, avril:3, mai:4, juin:5, juil:6, août:7, sept:8, oct:9, nov:10, déc:11 };
  const key = Object.keys(months).find(k => m[2].replace(".","").toLowerCase().startsWith(k));
  return key === undefined ? null : new Date(Number(m[3]), months[key], Number(m[1]));
}
async function refresh() {
  if (Date.now() - cache.at < 6 * 60 * 60 * 1000) return cache.events;
  const found = [];
  // Keep the first dashboard request bounded: fetch a few agenda pages in parallel,
  // with a timeout, instead of walking up to 25 pages sequentially.
  const pages = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
    const page = index + 1;
    const url = page === 1 ? SOURCE : SOURCE + "page/" + page + "/";
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "JML-Projet-Vendeur/1.0" },
        signal: AbortSignal.timeout(4500)
      });
      return response.ok ? await response.text() : "";
    } catch (_error) {
      return "";
    }
  }));
  for (const html of pages) {
    if (!html) continue;
    const links = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/www\.ardennes\.com\/agenda\/[^"']+)["'][^>]*>([\s\S]{1,500}?)<\/a>/gi)];
    for (const match of links) {
      const title = textOf(match[2]);
      if (!title || title.length < 4) continue;
      const context = textOf(html.slice(match.index, match.index + 3000));
      const dates = [...context.matchAll(/\b\d{1,2}\s+(?:janv?\.?|févr?\.?|mars|avril|mai|juin|juil?\.?|août|sept?\.?|oct?\.?|nov?\.?|déc?\.?)\s+\d{4}\b/gi)].map(x => parseDate(x[0])).filter(Boolean);
      if (!dates.length) continue;
      const end = dates[dates.length - 1];
      if (end.getTime() < Date.now() - 86400000) continue;
      const cityMatch = context.match(/\b(CHARLEVILLE MEZIERES|SEDAN|REVIN|RETHEL|GIVET|FUMAY|VOUZIERS|ROCROI|MONTHERME|MOUZON|CARIGNAN|FLIZE|BAZEILLES|AIGLEMONT)\b/i);
      const typeMatch = context.match(/\b(Concert|Marché|Randonnée|Visites guidées|Exposition|Manifestation Culturelle|Manifestation sportive|Animation locale|Théâtre|Musique|Enfants|Insolite)\b/i);
      found.push({ title, city: cityMatch ? cityMatch[1] : "Ardennes", type: typeMatch ? typeMatch[1] : "Événement", start: dates[0].toISOString(), end: end.toISOString(), url: match[1] });
    }
  }
  const seen = new Set();
  const freshEvents = found.filter(e => { const key = e.title + "|" + e.city + "|" + e.start; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a,b) => new Date(a.start) - new Date(b.start));
  if (!freshEvents.length && cache.events.length) return cache.events;
  cache = { at: Date.now(), events: freshEvents };
  return cache.events;
}
module.exports = function registerPublicEventsRoute(app, clean) {
  app.get("/api/public-events", async (req, res) => {
    try {
      const all = await refresh();
      const city = clean(req.query.city, 100).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const propertyType = clean(req.query.propertyType, 50).toLowerCase();
      const local = city ? all.filter(e => e.city.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(city)) : [];
      const pool = local.length ? local : all;
      const scored = pool.filter(e => new Date(e.end) >= new Date()).map(e => {
        let score = 0;
        if (/concert|exposition|théâtre|musique|visites|culture/i.test(e.type)) score += propertyType === "appartement" ? 3 : 1;
        if (/marché|animation|enfants|nature/i.test(e.type)) score += propertyType === "maison" ? 3 : 1;
        return { ...e, score };
      }).sort((a,b) => b.score - a.score || new Date(a.start) - new Date(b.start)).slice(0, 3);
      res.json({ ok: true, source: SOURCE, updatedAt: new Date().toISOString(), events: scored });
    } catch (error) {
      console.error("JML public events:", error.message);
      res.status(503).json({ ok: false, error: "Événements indisponibles." });
    }
  });
};
