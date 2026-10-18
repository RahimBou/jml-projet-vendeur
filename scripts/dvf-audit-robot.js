#!/usr/bin/env node
"use strict";

/**
 * JML — Robot de diagnostic DVF gratuit (lecture seule).
 *
 * Source: fichiers DVF officiels DGFiP diffusés sur data.gouv.fr.
 * Ce script ne se connecte pas à PostgreSQL et ne modifie aucune donnée.
 *
 * Usage:
 *   node scripts/dvf-audit-robot.js
 *   node scripts/dvf-audit-robot.js --years=2021,2022,2023,2024,2025
 *   node scripts/dvf-audit-robot.js --years=2024,2025 --out=/tmp/jml-dvf-audit.json
 */

const fs = require("node:fs");
const zlib = require("node:zlib");

const DEFAULT_YEARS = "2021,2022,2023,2024,2025";
const DEPARTMENT = String(process.env.DVF_DEPARTMENT || "08").padStart(2, "0");
const BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv";

function argValue(prefix) {
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

const years = String(argValue("--years=") || process.env.DVF_AUDIT_YEARS || DEFAULT_YEARS)
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((year) => Number.isInteger(year) && year >= 2014 && year <= 2100);

const outputPath = argValue("--out=");

if (!years.length) {
  console.error("Aucune année valide. Exemple : --years=2021,2022,2023,2024,2025");
  process.exit(2);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function numberOrNull(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text.replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeAddress(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function emptyCounts(year) {
  return {
    year,
    status: "pending",
    sourceRows: 0,
    saleRows: 0,
    residentialRows: 0,
    houseRows: 0,
    apartmentRows: 0,
    otherLocalRows: 0,
    missingMutationIdRows: 0,
    missingPriceRows: 0,
    nonPositivePriceRows: 0,
    missingSurfaceRows: 0,
    nonPositiveSurfaceRows: 0,
    missingLatitudeRows: 0,
    missingLongitudeRows: 0,
    rowsWithPriceAndSurface: 0,
    rowsWithPriceSurfaceAndCoordinates: 0,
    distinctSaleMutations: 0,
    mutationsWithMultipleResidentialRows: 0,
    residentialRowsInMultiRowMutations: 0,
    sourceUrl: null,
    error: null
  };
}

async function auditYear(year) {
  const result = emptyCounts(year);
  const url = `${BASE_URL}/${year}/departements/${DEPARTMENT}.csv.gz`;
  result.sourceUrl = url;
  console.log(`\n[DVF ${year}] Téléchargement du fichier officiel…`);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/gzip",
        "User-Agent": "JML-DVF-Free-Audit-Robot/1.0"
      },
      signal: AbortSignal.timeout(180000)
    });

    if (response.status === 404) {
      result.status = "unavailable";
      result.error = "Fichier officiel absent (HTTP 404) ; année non comptée comme importée.";
      console.log(`[DVF ${year}] Fichier indisponible (404).`);
      return result;
    }
    if (!response.ok) {
      throw new Error(`Téléchargement HTTP ${response.status}`);
    }

    const compressed = Buffer.from(await response.arrayBuffer());
    const csv = zlib.gunzipSync(compressed).toString("utf8");
    const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
    if (lines.length < 2) throw new Error("Fichier vide ou sans lignes de données.");

    const headers = parseCsvLine(lines[0]).map((value) => value.trim());
    const index = Object.fromEntries(headers.map((header, i) => [header, i]));
    const required = [
      "id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere",
      "type_local", "surface_reelle_bati", "latitude", "longitude"
    ];
    const missingColumns = required.filter((name) => index[name] === undefined);
    if (missingColumns.length) {
      throw new Error(`Colonnes officielles manquantes : ${missingColumns.join(", ")}`);
    }

    const mutationResidentialCounts = new Map();
    const mutationResidentialSignatures = new Map();

    for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
      const row = parseCsvLine(lines[lineIndex]);
      result.sourceRows += 1;
      if (textOrNull(row[index.nature_mutation]) !== "Vente") continue;

      result.saleRows += 1;
      const mutationId = textOrNull(row[index.id_mutation]);
      const propertyType = textOrNull(row[index.type_local]);
      const price = numberOrNull(row[index.valeur_fonciere]);
      const surface = numberOrNull(row[index.surface_reelle_bati]);
      const latitude = numberOrNull(row[index.latitude]);
      const longitude = numberOrNull(row[index.longitude]);

      if (!mutationId) result.missingMutationIdRows += 1;
      if (price === null) result.missingPriceRows += 1;
      else if (price <= 0) result.nonPositivePriceRows += 1;
      if (surface === null) result.missingSurfaceRows += 1;
      else if (surface <= 0) result.nonPositiveSurfaceRows += 1;
      if (latitude === null) result.missingLatitudeRows += 1;
      if (longitude === null) result.missingLongitudeRows += 1;
      if (price !== null && price > 0 && surface !== null && surface > 0) {
        result.rowsWithPriceAndSurface += 1;
      }
      if (price !== null && price > 0 && surface !== null && surface > 0 &&
          latitude !== null && longitude !== null) {
        result.rowsWithPriceSurfaceAndCoordinates += 1;
      }

      if (propertyType === "Maison" || propertyType === "Appartement") {
        result.residentialRows += 1;
        if (propertyType === "Maison") result.houseRows += 1;
        if (propertyType === "Appartement") result.apartmentRows += 1;

        if (mutationId) {
          mutationResidentialCounts.set(
            mutationId,
            (mutationResidentialCounts.get(mutationId) || 0) + 1
          );
          const address = [
            row[index.adresse_numero],
            row[index.adresse_suffixe],
            row[index.adresse_nom_voie]
          ].map(textOrNull).filter(Boolean).join(" ");
          const signature = [
            propertyType,
            surface ?? "",
            row[index.nombre_pieces_principales] ?? "",
            row[index.surface_terrain] ?? "",
            normalizeAddress(address)
          ].join("|");
          if (!mutationResidentialSignatures.has(mutationId)) {
            mutationResidentialSignatures.set(mutationId, new Set());
          }
          mutationResidentialSignatures.get(mutationId).add(signature);
        }
      } else if (propertyType) {
        result.otherLocalRows += 1;
      }
    }

    result.distinctSaleMutations = mutationResidentialCounts.size;
    for (const [mutationId, count] of mutationResidentialCounts.entries()) {
      if (count > 1) {
        result.mutationsWithMultipleResidentialRows += 1;
        result.residentialRowsInMultiRowMutations += count;
      }
    }

    result.status = "ok";
    console.log(
      `[DVF ${year}] ${result.sourceRows} lignes brutes ; ${result.saleRows} lignes Vente ; ` +
      `${result.residentialRows} lignes maisons/appartements ; ` +
      `${result.distinctSaleMutations} mutations contenant au moins un bien résidentiel.`
    );
    return result;
  } catch (error) {
    result.status = "error";
    result.error = String(error?.message || error);
    console.error(`[DVF ${year}] ERREUR : ${result.error}`);
    return result;
  }
}

async function main() {
  const report = {
    reportType: "jml-dvf-free-audit",
    generatedAt: new Date().toISOString(),
    department: DEPARTMENT,
    source: "DVF officielle DGFiP diffusée sur data.gouv.fr",
    databaseTouched: false,
    importsPerformed: false,
    note: "Diagnostic uniquement : aucun accès PostgreSQL, aucune écriture et aucune suppression.",
    years: []
  };

  for (const year of [...new Set(years)].sort((a, b) => a - b)) {
    report.years.push(await auditYear(year));
  }

  const totals = report.years.reduce((sum, year) => {
    if (year.status !== "ok") return sum;
    for (const key of [
      "sourceRows", "saleRows", "residentialRows", "houseRows", "apartmentRows",
      "otherLocalRows", "missingMutationIdRows", "missingPriceRows",
      "nonPositivePriceRows", "missingSurfaceRows", "nonPositiveSurfaceRows",
      "missingLatitudeRows", "missingLongitudeRows", "rowsWithPriceAndSurface",
      "rowsWithPriceSurfaceAndCoordinates", "mutationsWithMultipleResidentialRows",
      "residentialRowsInMultiRowMutations"
    ]) sum[key] = (sum[key] || 0) + year[key];
    return sum;
  }, {});
  report.totals = totals;
  report.successfulYears = report.years.filter((year) => year.status === "ok").map((year) => year.year);
  report.unavailableYears = report.years.filter((year) => year.status === "unavailable").map((year) => year.year);
  report.failedYears = report.years.filter((year) => year.status === "error").map((year) => year.year);

  const json = JSON.stringify(report, null, 2);
  if (outputPath) {
    fs.writeFileSync(outputPath, json + "\n", { encoding: "utf8", mode: 0o600 });
    console.log(`\nRapport JSON enregistré : ${outputPath}`);
  }
  console.log("\n=== RAPPORT DVF JML (aucune écriture en base) ===");
  console.log(json);

  if (!report.successfulYears.length || report.failedYears.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Robot DVF arrêté :", error?.message || error);
  process.exitCode = 1;
});
