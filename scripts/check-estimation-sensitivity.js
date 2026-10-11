#!/usr/bin/env node
"use strict";

// Characterization/guard tests for the existing estimation path.
// These tests inspect production source and exercise exposed arithmetic;
// they do not replace a live PostgreSQL/Render replay with real DVF rows.
const fs = require("node:fs");
const assert = require("node:assert/strict");

const server = fs.readFileSync("server.js", "utf8");
const dashboard = fs.readFileSync("public/espace-vendeur.html", "utf8");
const sector = fs.readFileSync("public/vendeur-secteur.html", "utf8");

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, label + ": début introuvable");
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, label + ": fin introuvable");
  return source.slice(start, end);
}

const comparableFn = section(
  server,
  "async function buildComparableSales(",
  '\napp.post("/api/estimator-agent/run"',
  "buildComparableSales"
);
const summaryRoute = section(
  server,
  'app.get("/api/territory-summary"',
  '\napp.get("/api/territory-nearby"',
  "territory-summary"
);
const comparableRoute = section(
  server,
  'app.get("/api/territory-comparables"',
  '\napp.get("/api/territory-nearby"',
  "territory-comparables"
);

// 1) Surface: final total must remain explicitly proportional to the selected €/m² base.
assert.match(summaryRoute, /Math\.round\(referenceBase\*sellerSurface\)/,
  "territory-summary doit calculer valeur = base €/m² × surface");
assert.match(sector, /referenceM2\s*\*\s*surf|weightedPriceM2\s*\*\s*surface|weightedPriceM2\*surface/,
  "Mon secteur doit conserver un calcul surface × prix/m² explicite");

// Deterministic arithmetic characterization of the production formula.
const priceM2 = 1704;
const estimate = surface => Math.round(priceM2 * surface);
assert.equal(estimate(150), 255600, "base 1 704 €/m² × 150 m²");
assert.equal(estimate(135), 230040, "surface -10 % doit réduire la valeur de 10 % à base constante");
assert.equal(estimate(165), 281160, "surface +10 % doit augmenter la valeur de 10 % à base constante");
assert.equal(estimate(165) - estimate(150), 25560, "écart de valeur cohérent avec +15 m²");

// 2) Type: incompatible DVF sales must be filtered before scoring.
assert.ok(comparableFn.includes('if(typeWanted&&classifyDvfType(sale.type,sale.codtypbien||"")!==typeWanted)return null;'),
  "le moteur doit filtrer les ventes dont le type ne correspond pas");
assert.match(comparableFn, /classifyDvfType\(property\?\.propertyType/,
  "le type du dossier doit déterminer le type DVF recherché");
assert.match(server, /isApartment\?Number\(market\?\.apartmentPrice\):isHouse\?Number\(market\?\.housePrice\)/,
  "le secours communal doit distinguer maison et appartement");

// 3) Comparable set: final value derives from the comparable price when available.
assert.match(summaryRoute, /Number\(comparable\?\.weightedPriceM2\)/,
  "territory-summary doit lire le prix/m² calculé des comparables");
assert.match(summaryRoute, /else if\(Number\.isFinite\(comparableBase\)&&comparableBase>0\)/,
  "le chemin de secours doit privilégier les comparables positifs avant le prix communal");
assert.match(comparableFn, /x\.weight=Math\.max\(0\.0001,\(x\.score\/100\)\*\*2/,
  "le poids des comparables doit être calculé depuis le score de similarité");

// 4) Owner-entered expected price must not be an input to the automated calculation.
const summaryCall = summaryRoute.match(/buildComparableSales\(market,\{([^}]*)\}\)/);
assert.ok(summaryCall, "l'appel du moteur comparable doit être explicite");
assert.doesNotMatch(summaryCall[1], /owner|expected|prix|price/i,
  "le prix envisagé par le propriétaire ne doit pas être transmis au moteur");
assert.doesNotMatch(comparableFn, /ownerExpectedPrice|expectedSalePrice|prixEnvisage|prixEnvisagé/i,
  "le prix envisagé par le propriétaire ne doit pas être lu dans le moteur");

// 5) Public contracts/pages: existing endpoints and consumers must remain present.
assert.match(summaryRoute, /return res\.json\(\{\s*ok:true,version:VERSION,build:BUILD_MARKER,commune,/,
  "la réponse OK de territory-summary doit garder ses champs de contrat");
assert.match(comparableRoute, /comparables:comparable/,
  "territory-comparables doit garder la clé JSON comparables");
assert.match(dashboard, /\/api\/territory-summary\?/,
  "le tableau de bord vendeur doit conserver son endpoint");
assert.match(sector, /\/api\/territory-comparables\?/,
  "Mon secteur doit conserver son endpoint");

console.log("OK — garde-fous statiques des chemins, du type, de la surface et des contrats API.");
console.log("OK — sensibilité arithmétique : 150 m² = 255 600 € ; 135 m² = 230 040 € ; 165 m² = 281 160 € (base constante de 1 704 €/m²).");
console.log("À compléter sur données réelles : relecture DVF PostgreSQL/Render, comparaison de types et de jeux de comparables pour 6 rue Payen-Guillemain.");
