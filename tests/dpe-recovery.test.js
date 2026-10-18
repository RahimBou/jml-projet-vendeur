"use strict";

const assert = require("node:assert/strict");
const { scoreCandidate, normalize } = require("../dpe-recovery");

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
