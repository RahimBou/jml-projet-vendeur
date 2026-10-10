// Collecte complémentaire pour l'aide à la décision vendeur JML.
// Les sources éditoriales ne sont jamais traitées comme des données chiffrées.
// Les chiffres ne sont transmis à Gemini que s'ils sont réellement récupérés.
const DEFAULT_HEADERS = {
  "Accept": "application/json,text/html,application/xhtml+xml",
  "User-Agent": "JML-Projet-Vendeur/3.14.2 (market-intelligence)"
};

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function fetchJson(url, timeoutMs = 5000) {
  const response = await fetch(url, {headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function checkReference(name, url, role) {
  try {
    const response = await fetch(url, {headers: DEFAULT_HEADERS, signal: AbortSignal.timeout(4500), redirect: "follow"});
    return {
      name, url, role,
      status: response.ok ? "accessible" : "indisponible",
      httpStatus: response.status,
      numericDataRetrieved: false,
      note: response.ok
        ? "Page accessible ; aucune valeur chiffrée n'est déduite de cette seule vérification."
        : "Page non récupérée ; ne pas utiliser comme preuve chiffrée."
    };
  } catch (error) {
    return {name, url, role, status: "non_verifiee", numericDataRetrieved: false,
      note: "Accès automatisé non confirmé. Ne pas inventer de valeur."};
  }
}

async function collectMarketIntelligence({city, communeCode, propertyType} = {}) {
  const requestedCity = String(city || "").trim().slice(0, 100);
  const code = /^\\d{5}$/.test(String(communeCode || "")) ? String(communeCode) : "";
  let territory = null;
  let territorySource = null;

  try {
    let rows = [];
    if (code) {
      rows = await fetchJson("https://geo.api.gouv.fr/communes?code=" + encodeURIComponent(code)
        + "&fields=nom,code,population,codesPostaux,departement,region&format=json");
    } else if (requestedCity) {
      rows = await fetchJson("https://geo.api.gouv.fr/communes?nom=" + encodeURIComponent(requestedCity)
        + "&fields=nom,code,population,codesPostaux,departement,region&boost=population&limit=10&format=json");
      const wanted = normalizeName(requestedCity);
      rows = rows.filter(row => normalizeName(row.nom) === wanted || String(row.code || "").startsWith("08"));
    }
    const row = Array.isArray(rows) ? rows.find(x => x && /^\\d{5}$/.test(String(x.code || ""))) : null;
    if (row) {
      territory = {
        commune: String(row.nom || requestedCity),
        communeCode: String(row.code),
        population: Number.isFinite(Number(row.population)) && Number(row.population) > 0 ? Number(row.population) : null,
        postalCodes: Array.isArray(row.codesPostaux) ? row.codesPostaux.filter(x => /^\\d{5}$/.test(String(x))).slice(0, 5) : [],
        departmentCode: String(row.departement?.code || String(row.code).slice(0, 2)),
        source: "API officielle geo.api.gouv.fr, données territoriales issues des référentiels publics",
        sourceUrl: "https://geo.api.gouv.fr/communes",
        retrievedAt: new Date().toISOString(),
        limitation: "La population correspond à la valeur du référentiel retourné ; vérifier l'année de référence dans l'INSEE avant toute comparaison temporelle."
      };
      territorySource = {name: "INSEE / référentiel communal via geo.api.gouv.fr", url: "https://geo.api.gouv.fr/communes",
        status: "donnee_recuperee", numericDataRetrieved: territory.population !== null,
        note: "Population communale récupérée automatiquement ; ce n'est pas une mesure de demande immobilière."};
    }
  } catch (error) {
    territorySource = {name: "INSEE / référentiel communal via geo.api.gouv.fr", url: "https://geo.api.gouv.fr/communes",
      status: "non_recuperee", numericDataRetrieved: false, note: "La donnée communale n'a pas pu être récupérée ; aucune valeur n'est supposée."};
  }

  const referenceChecks = await Promise.all([
    checkReference("INSEE — dossier du département des Ardennes", "https://www.insee.fr/fr/statistiques/2011101?geo=DEP-08", "Contexte démographique et économique officiel"),
    checkReference("CCI Marne Ardennes — M.A Data Clés", "https://www.marneardennes.cci.fr/produit/ma-data-cles", "Contexte économique local ; accès aux exports à vérifier"),
    checkReference("Notaires de France — immobilier", "https://www.immobilier.notaires.fr/", "Référence notariale ; aucune statistique locale extraite automatiquement ici"),
    checkReference("DVF — données de ventes", "https://explore.data.gouv.fr/fr/immobilier", "Référence des transactions ; les ventes DVF calculées par JML restent prioritaires")
  ]);

  return {
    retrievedAt: new Date().toISOString(),
    territory,
    sourceChecks: [territorySource, ...referenceChecks].filter(Boolean),
    methodology: [
      "DVF JML reste la référence principale des ventes enregistrées.",
      "Les prix issus des portails sont des repères d'estimation ou des prix affichés, pas des prix de vente signés.",
      "La CCI et les Notaires ne sont pas considérés comme sources chiffrées tant qu'une donnée exploitable, datée et vérifiable n'a pas été extraite."
    ],
    propertyType: String(propertyType || "").slice(0, 50)
  };
}

module.exports = { collectMarketIntelligence };
