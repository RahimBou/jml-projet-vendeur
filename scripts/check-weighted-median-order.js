#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

const source = fs.readFileSync("server.js", "utf8");
const start = source.indexOf("async function buildComparableSales(");
assert.notEqual(start, -1, "buildComparableSales doit exister dans server.js");

const end = source.indexOf('\n}\napp.post("/api/estimator-agent/run"', start);
assert.notEqual(end, -1, "fin de buildComparableSales introuvable");
const body = source.slice(start, end);

const declaration = body.indexOf("let weightedMedianPriceM2=null,weightedMedianSaleId=null,acc=0;");
const winnerRead = body.indexOf("sale.weightedMedianWinner=String(sale.id)===weightedMedianSaleId;");
const winnerCalculation = body.indexOf("for(const x of weightedRows){acc+=x.weight;");
const winnerFallback = body.indexOf("if(weightedMedianPriceM2===null&&weightedRows.length)");
assert.ok(declaration >= 0, "la médiane pondérée doit déclarer ses variables");
assert.ok(winnerCalculation >= 0, "la médiane pondérée doit être calculée");
assert.ok(winnerFallback >= 0, "le cas de secours de la médiane doit être conservé");
assert.ok(winnerRead >= 0, "le comparable gagnant doit être marqué");
assert.ok(declaration < winnerCalculation, "les variables doivent être déclarées avant le calcul");
assert.ok(winnerCalculation < winnerRead, "le gagnant doit être marqué après le calcul de la médiane");
assert.ok(winnerFallback < winnerRead, "le gagnant doit être marqué après le secours éventuel");

console.log("OK — ordre d'initialisation de la médiane pondérée vérifié.");
