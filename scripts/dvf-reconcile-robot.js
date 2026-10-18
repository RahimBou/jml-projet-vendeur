#!/usr/bin/env node
"use strict";

/**
 * JML DVF — récupération et réconciliation en zone de préparation.
 *
 * Télécharge les fichiers DVF officiels, les contrôle puis conserve un instantané
 * immuable des lignes source dans des tables de staging dédiées. Ne modifie JAMAIS
 * jml_dvf_sales ni jml_dvfplus_sales et ne supprime aucun historique.
 *
 * Modes :
 *   node scripts/dvf-reconcile-robot.js --dry-run
 *   node scripts/dvf-reconcile-robot.js --years=2021,2022,2023,2024,2025,2026 --dry-run
 *   node scripts/dvf-reconcile-robot.js --years=2021,2022,2023,2024,2025,2026
 *
 * Sans --dry-run, nécessite DATABASE_URL et crée seulement les tables jml_dvf_stage_*.
 * Une promotion vers les tables utilisées par le moteur d'estimation reste une étape
 * séparée et explicitement contrôlée.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const readline = require("node:readline");
const { once } = require("node:events");

const BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const DEPARTMENT = String(process.env.DVF_DEPARTMENT || "08").padStart(2, "0");
const DEFAULT_YEARS = "2021,2022,2023,2024,2025,2026";
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
function option(prefix) {
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}
const years = [...new Set(String(option("--years=") || process.env.DVF_IMPORT_YEARS || DEFAULT_YEARS)
  .split(",").map(v => Number(v.trim())).filter(v => Number.isInteger(v) && v >= 2014 && v <= 2100))]
  .sort((a,b) => a-b);
const dataDir = path.resolve(option("--dir=") || path.join(os.tmpdir(), "jml-dvf-stage", DEPARTMENT));
const MAX_BATCH = 250;

function parseCsvLine(line) {
  const out = [];
  let cur = "", quoted = false;
  for (let i=0;i<line.length;i++) {
    const ch=line[i];
    if (ch === '"') {
      if (quoted && line[i+1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) { out.push(cur); cur=""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function clean(v) { return String(v ?? "").trim() || null; }
function normalizeDate(value) {
  const raw=String(value ?? "").trim();
  if (!raw) return null;
  const fr=raw.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2]}-${fr[1]}`;
  const iso=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return iso ? raw : null;
}
function num(v) {
  const s=String(v ?? "").trim();
  if (!s) return null;
  const n=Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function fingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function normalizeAddress(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function buildRow(headers, cells, year) {
  const idx = Object.fromEntries(headers.map((h,i)=>[h,i]));
  const get = key => idx[key] === undefined ? null : cells[idx[key]];
  const row = {
    sourceYear: year,
    mutationId: clean(get("id_mutation")),
    saleDate: normalizeDate(get("date_mutation")),
    mutationType: clean(get("nature_mutation")),
    value: num(get("valeur_fonciere")),
    propertyType: clean(get("type_local")),
    surface: num(get("surface_reelle_bati")),
    rooms: num(get("nombre_pieces_principales")),
    landSurface: num(get("surface_terrain")),
    latitude: num(get("latitude")),
    longitude: num(get("longitude")),
    streetNumber: clean(get("adresse_numero")),
    streetSuffix: clean(get("adresse_suffixe")),
    street: clean(get("adresse_nom_voie")),
    postalCode: clean(get("code_postal")),
    communeCode: clean(get("code_commune")),
    communeName: clean(get("nom_commune")),
    parcelId: clean(get("id_parcelle")),
    natureCulture: clean(get("nature_culture")),
    natureCultureSpecial: clean(get("nature_culture_speciale"))
  };
  row.address = [row.streetNumber, row.streetSuffix, row.street].filter(Boolean).join(" ") || null;
  row.rowFingerprint = fingerprint(JSON.stringify(row));
  row.residential = row.mutationType === "Vente" && ["Maison","Appartement"].includes(row.propertyType);
  row.rejectionReasons = [];
  if (row.mutationType !== "Vente") row.rejectionReasons.push("not_sale");
  if (!row.mutationId) row.rejectionReasons.push("missing_mutation_id");
  if (row.residential && !(row.value > 0)) row.rejectionReasons.push("invalid_price");
  if (row.residential && !(row.surface > 0)) row.rejectionReasons.push("invalid_built_surface");
  if (row.residential && (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude))) row.rejectionReasons.push("missing_coordinates");
  return row;
}
function compareFingerprints(previous, current) {
  const before = previous instanceof Set ? previous : new Set(previous || []);
  const after = current instanceof Set ? current : new Set(current || []);
  let added = 0, unchanged = 0, removed = 0;
  for (const fp of after) { if (before.has(fp)) unchanged++; else added++; }
  for (const fp of before) if (!after.has(fp)) removed++;
  return { previousRows: before.size, currentRows: after.size, added, unchanged, removed };
}
function summarize(rows) {
  const counts = { rows:0, sales:0, residential:0, validResidential:0, rejectedResidential:0, missingMutationId:0 };
  for (const r of rows) {
    counts.rows++;
    if (r.mutationType === "Vente") counts.sales++;
    if (r.residential) {
      counts.residential++;
      if (r.value > 0 && r.surface > 0 && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)) counts.validResidential++;
      else counts.rejectedResidential++;
    }
    if (!r.mutationId) counts.missingMutationId++;
  }
  return counts;
}
async function downloadYear(year) {
  const url = `${BASE_URL}/${year}/departements/${DEPARTMENT}.csv.gz`;
  const dest = path.join(dataDir, `${year}-${DEPARTMENT}.csv.gz`);
  // Par défaut, télécharger la publication courante à chaque exécution pour
  // ne jamais rater les corrections semestrielles. --reuse-cache est explicite.
  if (process.argv.includes("--reuse-cache") && fs.existsSync(dest) &&
      fs.statSync(dest).size > 0 && !force) {
    const cached = fs.statSync(dest);
    return { path:dest, url, downloaded:false, bytes:cached.size };
  }
  const response = await fetch(url, {headers:{Accept:"application/gzip","User-Agent":"JML-DVF-Reconcile-Robot/1.0"},signal:AbortSignal.timeout(180000)});
  if (response.status === 404) return { unavailable:true, year, url, httpStatus:404 };
  if (!response.ok) throw new Error(`DVF ${year}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error(`DVF ${year}: gzip invalide`);
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const temp = dest + `.part-${process.pid}`;
  fs.writeFileSync(temp,bytes,{flag:"w",mode:0o600});
  fs.renameSync(temp,dest);
  return {path:dest,url,downloaded:true,bytes:bytes.length};
}
async function readYear(year, filePath) {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({input:stream,crlfDelay:Infinity});
  let headers=null, rows=[], rowCount=0, invalidColumnCount=0;
  const batch=[];
  for await (const line of rl) {
    if (!headers) {
      headers=parseCsvLine(line).map(v=>v.trim());
      const required=["id_mutation","date_mutation","nature_mutation","valeur_fonciere","type_local","surface_reelle_bati"];
      const missing=required.filter(v=>!headers.includes(v));
      if (missing.length) throw new Error(`DVF ${year}: colonnes manquantes ${missing.join(", ")}`);
      continue;
    }
    if (!line) continue;
    const cells=parseCsvLine(line);
    if (cells.length !== headers.length) invalidColumnCount++;
    const row=buildRow(headers,cells,year);
    // Fingerprint covers the source row content we use; malformed short rows remain auditable.
    batch.push({ ...row, raw: cells });
    rowCount++;
    if (batch.length >= MAX_BATCH) {
      rows.push(...batch.splice(0,batch.length));
    }
  }
  rows.push(...batch);
  if (!headers || !rowCount) throw new Error(`DVF ${year}: fichier vide/incomplet`);
  return {headers,rows,rowCount,invalidColumnCount,summary:summarize(rows)};
}
async function insertStaging(client, year, file, parsed) {
  await client.query("BEGIN");
  try {
    const prior = await client.query(
      "SELECT id, source_sha256, status FROM jml_dvf_stage_batches WHERE source_year=$1 AND status IN ('complete','unchanged') ORDER BY created_at DESC LIMIT 1",
      [year]
    );
    if (prior.rowCount && prior.rows[0].source_sha256 === file.sha256) {
      await client.query("UPDATE jml_dvf_stage_batches SET status='unchanged', finished_at=NOW() WHERE id=$1",[prior.rows[0].id]);
      await client.query("COMMIT");
      return {batchId:prior.rows[0].id,unchanged:true,stagedRows:0,reconciliation:null};
    }
    let reconciliation = {previousRows:0,currentRows:parsed.rows.length,added:parsed.rows.length,unchanged:0,removed:0};
    if (prior.rowCount) {
      const oldRows = await client.query("SELECT row_fingerprint FROM jml_dvf_stage_rows WHERE batch_id=$1",[prior.rows[0].id]);
      reconciliation = compareFingerprints(oldRows.rows.map(row => row.row_fingerprint), parsed.rows.map(row => row.rowFingerprint));
    }
    const batchSummary = {...parsed.summary, reconciliation};
    const batch = await client.query(`INSERT INTO jml_dvf_stage_batches
      (source_year,department,source_url,source_sha256,status,source_rows,summary)
      VALUES ($1,$2,$3,$4,'loading',$5,$6::jsonb) RETURNING id`,
      [year,DEPARTMENT,file.url,file.sha256,parsed.rowCount,JSON.stringify(batchSummary)]);
    const batchId=batch.rows[0].id;
    // Snapshots immuables : les publications antérieures ne sont ni supprimées ni écrasées.
    for(let i=0;i<parsed.rows.length;i+=MAX_BATCH) {
      const part=parsed.rows.slice(i,i+MAX_BATCH);
      for (const r of part) {
        await client.query(`INSERT INTO jml_dvf_stage_rows
          (batch_id,source_year,row_fingerprint,mutation_id,sale_date,mutation_type,property_type,price,surface,rooms,land_surface,latitude,longitude,address,postal_code,commune_code,commune_name,parcel_id,residential,rejection_reasons,raw_row)
          VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21::jsonb)
          ON CONFLICT (batch_id,row_fingerprint) DO NOTHING`,
          [batchId,year,r.rowFingerprint,r.mutationId,r.saleDate,r.mutationType,r.propertyType,r.value,r.surface,r.rooms,r.landSurface,r.latitude,r.longitude,r.address,r.postalCode,r.communeCode,r.communeName,r.parcelId,r.residential,JSON.stringify(r.rejectionReasons),JSON.stringify(r.raw)]);
      }
    }
    await client.query("UPDATE jml_dvf_stage_batches SET status='complete', finished_at=NOW() WHERE id=$1",[batchId]);
    await client.query("COMMIT");
    return {batchId,unchanged:false,stagedRows:parsed.rowCount,reconciliation};
  } catch(error) { await client.query("ROLLBACK"); throw error; }
}

async function main() {
  if (!years.length) throw new Error("Aucune année valide demandée.");
  const report={robot:"jml-dvf-reconcile",generatedAt:new Date().toISOString(),department:DEPARTMENT,source:"DGFiP / data.gouv.fr",dryRun,databaseTouched:false,productionTablesTouched:false,years:[]};
  let pool=null;
  if (!dryRun) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante ; utilisez --dry-run pour audit sans base.");
    const {Pool}=require("pg");
    pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:15000});
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE IF NOT EXISTS jml_dvf_stage_batches (
        id BIGSERIAL PRIMARY KEY, source_year INTEGER NOT NULL, department TEXT NOT NULL,
        source_url TEXT NOT NULL, source_sha256 TEXT NOT NULL, status TEXT NOT NULL,
        source_rows INTEGER NOT NULL DEFAULT 0, summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_jml_dvf_stage_batches_year ON jml_dvf_stage_batches(source_year,created_at DESC)`);
      await client.query(`CREATE TABLE IF NOT EXISTS jml_dvf_stage_rows (
        id BIGSERIAL PRIMARY KEY, batch_id BIGINT NOT NULL REFERENCES jml_dvf_stage_batches(id),
        source_year INTEGER NOT NULL, row_fingerprint CHAR(64) NOT NULL,
        mutation_id TEXT, sale_date DATE, mutation_type TEXT, property_type TEXT,
        price NUMERIC, surface NUMERIC, rooms NUMERIC, land_surface NUMERIC,
        latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, address TEXT,
        postal_code TEXT, commune_code TEXT, commune_name TEXT, parcel_id TEXT,
        residential BOOLEAN NOT NULL DEFAULT FALSE, rejection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        raw_row JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(batch_id,row_fingerprint)
      )`);
      await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvf_stage_rows_date ON jml_dvf_stage_rows(sale_date,source_year)");
      await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvf_stage_rows_mutation ON jml_dvf_stage_rows(source_year,mutation_id)");
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK"); throw error; }
    client.release();
  }

  try {
    for (const year of years) {
      const item={year,status:"pending"};
      try {
        const file=await downloadYear(year);
        if(file.unavailable) { Object.assign(item,{status:"unavailable",sourceUrl:file.url}); report.years.push(item); continue; }
        const digest=crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex");
        file.sha256=digest;
        const parsed=await readYear(year,file.path);
        Object.assign(item,{status:"audited",sourceUrl:file.url,downloaded:file.downloaded,bytes:file.bytes,sha256:digest,summary:parsed.summary,sourceRows:parsed.rowCount,malformedColumnRows:parsed.invalidColumnCount});
        if (!dryRun) {
          const client=await pool.connect();
          try {
            const saved=await insertStaging(client,year,file,parsed);
            Object.assign(item,{status:saved.unchanged?"unchanged":"staged",batchId:saved.batchId,stagedRows:saved.stagedRows});
          } finally { client.release(); }
        }
      } catch(error) { item.status="error"; item.error=String(error?.message||error); report.errors=(report.errors||[]).concat([{year,error:item.error}]); }
      report.years.push(item);
    }
  } finally { if(pool) await pool.end(); }
  report.databaseTouched=!dryRun && report.years.some(y=>["staged","unchanged"].includes(y.status));
  report.productionTablesTouched=false;
  const reportPath=path.join(dataDir,"reconcile-report.json");
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n",{mode:0o600});
  console.log(JSON.stringify(report,null,2));
  if (report.errors?.length) process.exitCode=1;
}
if (require.main === module) {
  main().catch(error=>{console.error("DVF reconcile robot failed:",error);process.exitCode=1;});
}

module.exports = { parseCsvLine, normalizeDate, buildRow, summarize, fingerprint, compareFingerprints };
