"use strict";

const assert = require("node:assert/strict");
const { scoreCandidate, canAutoMatch, normalize } = require("../dpe-recovery");

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
