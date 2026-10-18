"use strict";
const assert = require("node:assert/strict");
const { parseCsvLine, normalizeDate, buildRow, summarize } = require("../scripts/dvf-reconcile-robot");

assert.deepEqual(parseCsvLine('a,"b,c","d""e",'), ["a","b,c",'d"e',""]);
assert.equal(normalizeDate("18/10/2026"), "2026-10-18");
assert.equal(normalizeDate("2026-10-18"), "2026-10-18");
assert.equal(normalizeDate("date-invalide"), null);

const headers = [
  "id_mutation","date_mutation","nature_mutation","valeur_fonciere",
  "type_local","surface_reelle_bati","nombre_pieces_principales","surface_terrain",
  "latitude","longitude","adresse_numero","adresse_suffixe","adresse_nom_voie",
  "code_postal","code_commune","nom_commune","id_parcelle"
];
const row = buildRow(headers, [
  "2026-001","18/10/2026","Vente","180000","Maison","100","5","300",
  "49.76","4.72","12","","Rue des Fleurs","08000","08105","Charleville-Mézières","08000AB001"
], 2026);
assert.equal(row.saleDate, "2026-10-18");
assert.equal(row.residential, true);
assert.equal(row.rejectionReasons.length, 0);
assert.equal(row.rowFingerprint.length, 64);

const invalid = buildRow(headers, [
  "2026-002","18/10/2026","Vente","0","Appartement","","","","","","4","","Rue Test",
  "08000","08105","Charleville-Mézières","08000AB002"
], 2026);
assert.ok(invalid.rejectionReasons.includes("invalid_price"));
assert.ok(invalid.rejectionReasons.includes("invalid_built_surface"));
assert.ok(invalid.rejectionReasons.includes("missing_coordinates"));
assert.deepEqual(summarize([row,invalid]).validResidential, 1);
console.log("OK — parsing CSV, dates, empreinte source et motifs de rejet DVF.");
