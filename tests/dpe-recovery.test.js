"use strict";

const assert = require("node:assert/strict");
const { scoreCandidate, canAutoMatch, normalize, mapDpe, mapLegacyDpe, fetchCandidates } = require("../dpe-recovery");

assert.equal(normalize("25 Rue de Belfort"), normalize("25 rue de Belfort"));
assert.equal(scoreCandidate({
  number: "25",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100,
  address: "25 Rue de Belfort 08000 Charleville-Mézières"
}, {
  number: "25",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100
}), 100);
assert.ok(scoreCandidate({
  number: "27",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100,
  address: "27 Rue de Belfort 08000 Charleville-Mézières"
}, {
  number: "25",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100
}) < 85);
console.log("OK — tests unitaires du score d'adresse DPE.");


const completeInput = {
  number: "25",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100
};
const exactDpe = {
  number: "25",
  street: "Rue de Belfort",
  postalCode: "08000",
  city: "Charleville-Mézières",
  surface: 100,
  energyClass: "D",
  validUntil: "2030-12-31",
  matchScore: 100
};
assert.equal(canAutoMatch(exactDpe, null, completeInput), true);
assert.equal(canAutoMatch({ ...exactDpe, surface: null }, null, completeInput), false,
  "Une surface absente ne doit pas permettre une attribution automatique.");
assert.equal(canAutoMatch({ ...exactDpe, validUntil: "2020-01-01" }, null, completeInput), false,
  "Un DPE expiré ne doit pas être attribué automatiquement.");
assert.equal(canAutoMatch({ ...exactDpe, energyClass: null }, null, completeInput), false,
  "Une classe énergétique absente ne doit pas être sélectionnée.");
console.log("OK — garde-fous de validation automatique DPE.");


// Les deux schémas ADEME ne sont pas identiques : contrôler les champs réellement employés.
const recentMapped = mapDpe({
  numero_dpe: "DPE-RECENT-1",
  adresse_complete_brut: "25 Rue de Belfort 08000 Charleville-Mézières",
  numero_voie_ban: "25",
  nom_rue_ban: "Rue de Belfort",
  code_postal_ban: "08000",
  nom_commune_ban: "Charleville-Mézières",
  surface_habitable_logement: 100,
  etiquette_dpe: "D",
  etiquette_ges: "C",
  date_fin_validite_dpe: "2030-12-31"
});
assert.equal(recentMapped.energyClass, "D");
assert.equal(recentMapped.surface, 100);
assert.equal(recentMapped.number, "25");

const legacyMapped = mapLegacyDpe({
  numero_dpe: "DPE-OLD-1",
  geo_adresse: "25 Rue de Belfort 08000 Charleville-Mézières",
  classe_consommation_energie: "E",
  classe_estimation_ges: "F",
  surface_thermique_lot: 87
});
assert.equal(legacyMapped.energyClass, "E");
assert.equal(legacyMapped.ghgClass, "F");
assert.equal(legacyMapped.surface, null,
  "La surface thermique de lot ancienne ne doit pas être assimilée à la surface habitable.");

assert.equal(canAutoMatch({ ...exactDpe, validUntil: null }, null, completeInput), false,
  "Sans date de validité connue, ne pas attribuer automatiquement le DPE.");
assert.equal(canAutoMatch({ ...exactDpe, validUntil: "invalid-date" }, null, completeInput), false,
  "Une date de validité illisible doit imposer une vérification.");

(async () => {
  const mockFetch = async url => {
    const value = String(url);
    if (value.includes("/dpe03existant/lines")) {
      return new Response(JSON.stringify({ results: [{
        numero_dpe: "DPE-RECENT-2",
        adresse_complete_brut: "25 Rue de Belfort 08000 Charleville-Mézières",
        numero_voie_ban: "25", nom_rue_ban: "Rue de Belfort",
        code_postal_ban: "08000", nom_commune_ban: "Charleville-Mézières",
        surface_habitable_logement: 100, etiquette_dpe: "D", etiquette_ges: "C",
        date_fin_validite_dpe: "2030-12-31"
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ results: [{
      numero_dpe: "DPE-OLD-2",
      geo_adresse: "25 Rue de Belfort 08000 Charleville-Mézières",
      classe_consommation_energie: "E",
      classe_estimation_ges: "F",
      surface_thermique_lot: 90
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const response = await fetchCandidates(completeInput, { fetch: mockFetch, forceRefresh: true });
  assert.equal(response.sources.length, 2, "Les deux sources ADEME doivent être interrogées.");
  assert.equal(response.sources.every(source => source.status === "ok"), true);
  assert.equal(response.selected?.dpeId, "DPE-RECENT-2");
  assert.equal(response.status, "matched");
  console.log("OK — tests des deux sources ADEME et de leur mapping.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
