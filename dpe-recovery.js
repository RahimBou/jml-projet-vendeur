"use strict";

/**
 * JML — recherche DPE ADEME par adresse (lecture seule).
 *
 * Source officielle ouverte : https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/ (DPE depuis juillet 2021).
 * Le jeu dpe-france concerne les diagnostics antérieurs à juillet 2021 ; il ne remplace pas la source actuelle.
 * Ne se connecte pas à PostgreSQL et n'écrit aucune donnée.
 *
 * IMPORTANT : un résultat trouvé par adresse n'est pas automatiquement attribué au bien.
 * Le module retourne des candidats avec un score explicable ; l'appelant doit conserver
 * les résultats ambigus comme "à vérifier" et ne jamais inventer une classe DPE.
 */

const API_BASE = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

function clean(value, max = 180) {
  return String(value ?? "").replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalize(value) {
  return clean(value, 300)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(avenue|av\.?|boulevard|bd\.?|route|rte\.?|chemin|chem\.?|impasse|imp\.?|place|pl\.?|rue|allee|allée)\b/g, " ")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function first(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(String(value).replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(result) ? result : null;
}

function mapDpe(row) {
  const address = first(row, ["adresse_complete_brut", "adresse_ban", "adresse_brut", "adresse", "Adresse"]);
  const number = first(row, ["numero_voie_ban", "numero_voie", "Numero_voie", "Numero_voie_BAN"]);
  const street = first(row, ["nom_rue_ban", "nom_rue", "Nom_rue", "Nom_rue_BAN"]);
  const city = first(row, ["nom_commune_ban", "nom_commune", "Commune"]);
  const postalCode = first(row, ["code_postal_ban", "code_postal", "Code_postal"]);
  const dpeId = first(row, ["numero_dpe", "numero_dpe_logement", "N°DPE", "Numero_DPE"]);
  const surface = numeric(first(row, ["surface_habitable_logement", "surface_habitable", "Surface_habitable_logement"]));
  const energy = first(row, ["etiquette_dpe", "etiquette_dpe_logement", "classe_energie", "Etiquette_DPE"]);
  const ghg = first(row, ["etiquette_ges", "etiquette_ges_logement", "classe_ges", "Etiquette_GES"]);
  const date = first(row, ["date_etablissement_dpe", "date_dpe", "Date_etablissement_DPE"]);
  const validUntil = first(row, ["date_fin_validite_dpe", "date_fin_validite", "Date_fin_validite_DPE"]);
  const lastModified = first(row, ["date_derniere_modification_dpe", "date_derniere_modification", "Date_derniere_modification_DPE"]);
  const floor = first(row, ["numero_etage_appartement", "numero_etage", "etage"]);
  const type = first(row, ["type_batiment", "type_bien", "Type_batiment"]);
  const addressParts = [number, street, postalCode, city].filter(Boolean);
  return {
    dpeId: clean(dpeId, 80) || null,
    address: clean(address, 240) || (addressParts.length ? clean(addressParts.join(" "), 240) : null),
    number: clean(number, 20) || null,
    street: clean(street, 120) || null,
    city: clean(city, 100) || null,
    postalCode: clean(postalCode, 10) || null,
    surface,
    energyClass: /^[A-G]$/i.test(String(energy || "").trim()) ? String(energy).trim().toUpperCase() : null,
    ghgClass: /^[A-G]$/i.test(String(ghg || "").trim()) ? String(ghg).trim().toUpperCase() : null,
    date: clean(date, 30) || null,
    validUntil: clean(validUntil, 30) || null,
    lastModified: clean(lastModified, 30) || null,
    floor: clean(floor, 20) || null,
    propertyType: clean(type, 60) || null,
    source: "ADEME — DPE logements existants",
    sourceUrl: "https://data.ademe.fr/datasets/dpe03existant"
  };
}

function scoreCandidate(dpe, input) {
  const wantedAddress = normalize([input.number, input.street, input.postalCode, input.city, input.address].filter(Boolean).join(" "));
  const foundAddress = normalize([dpe.number, dpe.street, dpe.postalCode, dpe.city, dpe.address].filter(Boolean).join(" "));
  let score = 0;
  const wantedNumber = normalize(input.number);
  const foundNumber = normalize(dpe.number);
  const wantedStreet = normalize(input.street || input.address);
  const foundStreet = normalize(dpe.street || dpe.address);
  if (wantedNumber && foundNumber && wantedNumber === foundNumber) score += 35;
  // Une adresse complète peut contenir le nom de rue ; éviter les correspondances
  // par sous-chaîne trop courte, sources fréquentes de faux positifs.
  if (wantedStreet && foundStreet &&
      (wantedStreet === foundStreet ||
       (wantedStreet.length >= 6 && foundStreet.includes(wantedStreet)) ||
       (foundStreet.length >= 6 && wantedStreet.includes(foundStreet)))) score += 30;
  if (input.postalCode && dpe.postalCode && String(input.postalCode).trim() === String(dpe.postalCode).trim()) score += 15;
  if (input.city && dpe.city && normalize(input.city) === normalize(dpe.city)) score += 10;
  const wantedSurface = numeric(input.surface);
  if (wantedSurface && dpe.surface) {
    const relativeDiff = Math.abs(wantedSurface - dpe.surface) / wantedSurface;
    if (relativeDiff <= 0.05) score += 10;
    else if (relativeDiff <= 0.15) score += 6;
    else if (relativeDiff <= 0.30) score += 2;
  }
  if (!wantedAddress || !foundAddress) score = Math.min(score, 25);
  return Math.min(score, 100);
}

function canAutoMatch(best, second, input) {
  // Une proximité textuelle ne suffit pas : exiger une adresse structurée, une
  // surface du logement cohérente, une classe énergétique valide et un DPE non expiré.
  const requiredAddressFields = Boolean(
    clean(input.number, 20) && clean(input.street, 120) &&
    clean(input.postalCode, 10) && clean(input.city, 100) &&
    best?.number && best?.street && best?.postalCode && best?.city
  );
  const wantedSurface = numeric(input.surface);
  const foundSurface = numeric(best?.surface);
  const surfaceMatches = wantedSurface !== null && foundSurface !== null &&
    Math.abs(wantedSurface - foundSurface) / wantedSurface <= 0.15;
  const validUntil = best?.validUntil ? new Date(best.validUntil) : null;
  const isNotExpired = !validUntil || Number.isNaN(validUntil.getTime()) ||
    validUntil.getTime() >= Date.now();
  const strongScore = best && best.matchScore >= 85 &&
    (!second || best.matchScore - second.matchScore >= 10);
  return Boolean(strongScore && requiredAddressFields && surfaceMatches &&
    best.energyClass && isNotExpired);
}

async function fetchCandidates(input, options = {}) {
  const address = clean(input.address || [input.number, input.street, input.postalCode, input.city].filter(Boolean).join(" "), 240);
  if (address.length < 5) {
    return { status: "invalid_address", matched: false, confidence: "none", candidates: [], message: "Adresse insuffisante pour rechercher un DPE." };
  }

  const key = normalize(address) + "|" + clean(input.surface, 20);
  const cached = cache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cache: true };
  }

  const url = new URL(API_BASE);
  url.searchParams.set("size", String(Math.max(1, Math.min(30, Number(options.limit) || 15))));
  // Data Fair full-text search. Results are always re-scored locally against the address
  // and dwelling surface; API text search alone is not considered a reliable match.
  url.searchParams.set("q", address);
  const response = await (options.fetch || fetch)(url, {
    headers: { Accept: "application/json", "User-Agent": "JML-Projet-Vendeur/1.0 (open-data DPE lookup)" },
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 10000)
  });
  if (!response.ok) {
    const error = new Error("API ADEME indisponible (HTTP " + response.status + ").");
    error.code = "ADEME_DPE_HTTP_ERROR";
    error.statusCode = response.status;
    throw error;
  }

  const payload = await response.json();
  const rows = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload?.data) ? payload.data : []);
  const candidates = rows.map(mapDpe)
    .filter(item => item.dpeId || item.address)
    .map(item => ({ ...item, matchScore: scoreCandidate(item, input) }))
    .sort((a, b) => b.matchScore - a.matchScore);

  const best = candidates[0] || null;
  const second = candidates[1] || null;
  let status = "not_found";
  let confidence = "none";
  let matched = false;
  if (canAutoMatch(best, second, input)) {
    status = "matched";
    confidence = "high";
    matched = true;
  } else if (best && best.matchScore >= 60) {
    status = "review_required";
    confidence = "medium";
  } else if (best) {
    status = "review_required";
    confidence = "low";
  }

  const result = {
    status,
    matched,
    confidence,
    searchedAt: new Date().toISOString(),
    source: "ADEME — DPE logements existants",
    sourceUrl: "https://data.ademe.fr/datasets/dpe03existant",
    candidates: candidates.slice(0, 10),
    selected: matched ? best : null,
    message: matched
      ? "Correspondance forte selon les champs disponibles ; contrôler les détails avant toute utilisation définitive."
      : candidates.length
        ? "Des candidats existent mais l'adresse ne permet pas une attribution automatique suffisamment fiable."
        : "Aucun DPE retrouvé dans cette recherche. Cela ne prouve pas qu'aucun diagnostic n'existe."
  };
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
  if (cache.size > 1000) {
    const now = Date.now();
    for (const [cacheKey, item] of cache) if (item.expiresAt <= now) cache.delete(cacheKey);
  }
  return result;
}

module.exports = { fetchCandidates, scoreCandidate, canAutoMatch, normalize };
