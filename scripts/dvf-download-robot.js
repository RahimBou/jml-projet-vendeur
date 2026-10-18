#!/usr/bin/env node
"use strict";

/**
 * JML — Robot gratuit de récupération des fichiers DVF officiels.
 * Télécharge les fichiers DGFiP depuis data.gouv.fr et les conserve en .csv.gz.
 * Ne se connecte jamais à PostgreSQL et ne modifie aucune table.
 *
 * Usage:
 *   node scripts/dvf-download-robot.js
 *   node scripts/dvf-download-robot.js --years=2021,2022,2023,2024,2025
 *   node scripts/dvf-download-robot.js --years=2024,2025 --dir=/opt/jml-projet-vendeur/data/dvf-raw
 *   node scripts/dvf-download-robot.js --years=2025 --force
 */

const fs = require("node:fs");
const path = require("node:path");

const BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const DEPARTMENT = String(process.env.DVF_DEPARTMENT || "08").padStart(2, "0");
const DEFAULT_YEARS = "2021,2022,2023,2024,2025";

function option(prefix) {
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

const years = [...new Set(
  String(option("--years=") || process.env.DVF_IMPORT_YEARS || DEFAULT_YEARS)
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((year) => Number.isInteger(year) && year >= 2014 && year <= 2100)
)].sort((a, b) => a - b);

const outputDir = path.resolve(
  option("--dir=") || path.join(process.cwd(), "data", "dvf-raw")
);
const force = process.argv.includes("--force");

async function downloadYear(year) {
  const filename = `${year}-departement-${DEPARTMENT}.csv.gz`;
  const destination = path.join(outputDir, filename);
  const url = `${BASE_URL}/${year}/departements/${DEPARTMENT}.csv.gz`;

  if (fs.existsSync(destination) && !force) {
    const stat = fs.statSync(destination);
    if (stat.size > 0) {
      console.log(`[DVF ${year}] Déjà présent, conservé sans écrasement : ${destination}`);
      return { year, status: "already_present", bytes: stat.size, file: destination };
    }
  }

  console.log(`[DVF ${year}] Téléchargement depuis la source officielle…`);
  const response = await fetch(url, {
    headers: {
      Accept: "application/gzip",
      "User-Agent": "JML-DVF-Free-Download-Robot/1.0"
    },
    signal: AbortSignal.timeout(180000)
  });

  if (response.status === 404) {
    console.warn(`[DVF ${year}] Fichier non disponible (HTTP 404), aucune donnée enregistrée.`);
    return { year, status: "unavailable", httpStatus: 404, url };
  }
  if (!response.ok) {
    throw new Error(`DVF ${year}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error(`DVF ${year}: la réponse n'est pas un fichier gzip valide.`);
  }

  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const temporary = destination + `.part-${process.pid}`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    // Rename on the same filesystem prevents a partial download appearing as complete.
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }

  const result = { year, status: "downloaded", bytes: bytes.length, file: destination, url };
  console.log(`[DVF ${year}] Fichier conservé : ${destination} (${bytes.length} octets).`);
  return result;
}

async function main() {
  if (!years.length) throw new Error("Aucune année valide. Exemple : --years=2021,2022,2023,2024,2025");
  console.log("Robot JML DVF — téléchargement officiel gratuit");
  console.log(`Département : ${DEPARTMENT} | Années : ${years.join(", ")}`);
  console.log(`Dossier local : ${outputDir}`);
  console.log("Mode : téléchargement uniquement ; aucune connexion à la base de données.");
  const results = [];

  for (const year of years) {
    try {
      results.push(await downloadYear(year));
    } catch (error) {
      results.push({ year, status: "error", error: String(error?.message || error) });
      console.error(`[DVF ${year}] ÉCHEC : ${error?.message || error}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    department: DEPARTMENT,
    source: "Fichiers DVF officiels DGFiP — data.gouv.fr",
    databaseTouched: false,
    importsPerformed: false,
    outputDir,
    results
  };
  const reportPath = path.join(outputDir, "download-report.json");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log("\nBilan :");
  console.log(JSON.stringify(report, null, 2));
  if (results.some((result) => result.status === "error")) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Robot DVF arrêté :", error?.message || error);
  process.exitCode = 1;
});
