#!/usr/bin/env node
"use strict";

/**
 * Import Immo Data DVF records into an isolated staging table.
 * Never writes to jml_dvf_sales, jml_dvfplus_sales, or the estimation engine tables.
 *
 * Safe by default: --dry-run. To persist, pass --write.
 * Cost is charged by Immo Data per page; default max pages is 2.
 *
 * Examples:
 *   node scripts/immo-data-import.js --dry-run --max-pages 2
 *   node scripts/immo-data-import.js --write --max-pages 5
 *   IMMO_DATA_GEO_LEVEL=department IMMO_DATA_CODE=08 node scripts/immo-data-import.js --dry-run
 */
const MCP_URL = String(process.env.IMMO_DATA_MCP_URL || "https://mcp.immo-data.fr/mcp").trim();
const API_KEY = String(process.env.IMMO_DATA_API_KEY || "").trim();
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const WRITE = process.argv.includes("--write");
const DRY_RUN = !WRITE;
const MAX_PAGES = Math.max(1, Math.min(10000, Number(
  process.argv.includes("--max-pages")
    ? process.argv[process.argv.indexOf("--max-pages") + 1]
    : process.env.IMMO_DATA_MAX_PAGES || 2
) || 2));
const PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.IMMO_DATA_PAGE_SIZE || 100) || 100));
const GEO_LEVEL = String(process.env.IMMO_DATA_GEO_LEVEL || "city");
const CODE = String(process.env.IMMO_DATA_CODE || "08105").trim();
const DATE_MIN = String(process.env.IMMO_DATA_DATE_MIN || "2014-01-01");
const DATE_MAX = String(process.env.IMMO_DATA_DATE_MAX || new Date().toISOString().slice(0, 10));
const TX_TYPES = String(process.env.IMMO_DATA_TX_TYPES || "sales").split(",").map(s => s.trim()).filter(Boolean);
const REALTY_TYPES = String(process.env.IMMO_DATA_REALTY_TYPES || "house,apartment").split(",").map(s => s.trim()).filter(Boolean);

if (!API_KEY) throw new Error("IMMO_DATA_API_KEY manquante.");
if (WRITE && !DATABASE_URL) throw new Error("DATABASE_URL manquante pour --write.");
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE_MIN) || !/^\d{4}-\d{2}-\d{2}$/.test(DATE_MAX)) {
  throw new Error("Dates invalides : utiliser AAAA-MM-JJ.");
}
if (!["city", "district", "subdistrict", "street", "parcel", "address"].includes(GEO_LEVEL)) {
  throw new Error("IMMO_DATA_GEO_LEVEL doit être city, district, subdistrict, street, parcel ou address.");
}
if (!CODE) throw new Error("IMMO_DATA_CODE manquant.");

const Pool = WRITE ? require("pg").Pool : null;
const pool = WRITE ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 15000
}) : null;

async function rpc(method, params = {}, id = 1) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(45000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("MCP HTTP " + response.status + ": " + body.slice(0, 300));
  const dataLines = body.split(/\r?\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim()).filter(Boolean);
  for (const candidate of (dataLines.length ? dataLines : [body]).reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.error) throw new Error("MCP " + JSON.stringify(parsed.error));
      if (parsed.result) return parsed.result;
    } catch (error) {
      if (String(error.message || "").startsWith("MCP ")) throw error;
    }
  }
  throw new Error("Réponse MCP non reconnue.");
}

function unwrap(result) {
  if (result?.isError) throw new Error("Outil Immo Data : " + JSON.stringify(result).slice(0, 800));
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.text) {
        try { return JSON.parse(item.text); } catch (_) {}
      }
    }
  }
  return result;
}

function getValue(obj, ...keys) {
  for (const key of keys) if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  return null;
}
function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function text(value) {
  return value === null || value === undefined || String(value).trim() === "" ? null : String(value).trim();
}
function isoDate(value) {
  const raw = text(value);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}
function coordsOf(item) {
  const coords = item?.location?.geometry?.coordinates || item?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const longitude = num(coords[0]), latitude = num(coords[1]);
    if (latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude };
    }
  }
  const latitude = num(item?.location?.latitude ?? item?.latitude);
  const longitude = num(item?.location?.longitude ?? item?.longitude);
  return latitude !== null && longitude !== null ? { latitude, longitude } : {};
}
function mapRecord(item) {
  const attributes = item?.attributes || {};
  const address = item?.location?.address || {};
  const coords = coordsOf(item);
  const price = num(getValue(item, "price", "salePrice"));
  const livingArea = num(getValue(attributes, "livingArea", "surface", "living_area"));
  const squareMeterPrice = num(getValue(item, "squareMeterPrice", "pricePerM2")) ??
    (price > 0 && livingArea > 0 ? price / livingArea : null);
  const rawType = String(getValue(item, "realtyType", "propertyType") || "").toLowerCase();
  const propertyType = rawType === "house" || rawType === "land" ? "Maison" :
    rawType === "apartment" ? "Appartement" : null;
  const txDate = isoDate(getValue(item, "txDate", "date", "saleDate"));
  const txId = text(getValue(item, "txId", "id", "transactionId"));
  const cityCode = text(getValue(address, "inseeCode", "cityCode")) ||
    text(getValue(item, "inseeCode", "communeCode"));
  const cityName = text(getValue(address, "cityName", "city", "commune"));
  const parcelId = text(getValue(item?.lot || {}, "parcelId", "id"));
  const rooms = num(getValue(attributes, "rooms", "roomCount"));
  const landArea = num(getValue(attributes, "landArea", "land_area"));
  const fullAddress = [
    getValue(address, "streetNumber"),
    getValue(address, "streetType"),
    getValue(address, "streetName")
  ].map(text).filter(Boolean).join(" ") || null;
  return {
    txId, saleDate: txDate, txType: text(item?.txType), propertyType,
    rawRealtyType: text(item?.realtyType), price, livingArea, squareMeterPrice,
    rooms, landArea, parcelId, cityCode, cityName, address: fullAddress,
    latitude: coords.latitude ?? null, longitude: coords.longitude ?? null,
    raw: item
  };
}
function validRecord(r) {
  return Boolean(r.txId && r.saleDate && r.price > 0 && r.propertyType &&
    r.livingArea > 0 && r.squareMeterPrice > 0);
}
async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS jml_immo_data_sales_staging (
      id BIGSERIAL PRIMARY KEY,
      tx_id TEXT NOT NULL UNIQUE,
      sale_date DATE NOT NULL,
      tx_type TEXT,
      property_type TEXT,
      raw_realty_type TEXT,
      price NUMERIC,
      living_area NUMERIC,
      price_per_m2 NUMERIC,
      rooms NUMERIC,
      land_area NUMERIC,
      parcel_id TEXT,
      commune_code TEXT,
      commune_name TEXT,
      address TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      raw_payload JSONB NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS idx_jml_immo_staging_date ON jml_immo_data_sales_staging(sale_date DESC)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_jml_immo_staging_commune_date ON jml_immo_data_sales_staging(commune_code, sale_date DESC)");
}
async function saveBatch(client, records) {
  if (!records.length) return 0;
  let affected = 0;
  for (const r of records) {
    const result = await client.query(`
      INSERT INTO jml_immo_data_sales_staging
        (tx_id,sale_date,tx_type,property_type,raw_realty_type,price,living_area,
         price_per_m2,rooms,land_area,parcel_id,commune_code,commune_name,address,
         latitude,longitude,raw_payload,last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,NOW())
      ON CONFLICT (tx_id) DO UPDATE SET
        sale_date=EXCLUDED.sale_date, tx_type=EXCLUDED.tx_type,
        property_type=EXCLUDED.property_type, raw_realty_type=EXCLUDED.raw_realty_type,
        price=EXCLUDED.price, living_area=EXCLUDED.living_area,
        price_per_m2=EXCLUDED.price_per_m2, rooms=EXCLUDED.rooms, land_area=EXCLUDED.land_area,
        parcel_id=EXCLUDED.parcel_id, commune_code=EXCLUDED.commune_code,
        commune_name=EXCLUDED.commune_name, address=EXCLUDED.address,
        latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
        raw_payload=EXCLUDED.raw_payload, last_seen_at=NOW()
    `, [
      r.txId,r.saleDate,r.txType,r.propertyType,r.rawRealtyType,r.price,r.livingArea,
      r.squareMeterPrice,r.rooms,r.landArea,r.parcelId,r.cityCode,r.cityName,r.address,
      r.latitude,r.longitude,JSON.stringify(r.raw)
    ]);
    affected += Number(result.rowCount || 0);
  }
  return affected;
}
async function main() {
  console.log("Mode :", DRY_RUN ? "APERÇU SANS ÉCRITURE" : "ÉCRITURE TABLE STAGING ISOLÉE");
  console.log("Zone :", GEO_LEVEL, CODE, "| dates :", DATE_MIN, "→", DATE_MAX,
    "| taille page :", PAGE_SIZE, "| maximum pages :", MAX_PAGES);
  console.log("Coût annoncé : 0,01 € par page. Budget maximal de cette exécution :",
    (MAX_PAGES * 0.01).toFixed(2), "€.");
  let client = null;
  if (WRITE) {
    client = await pool.connect();
    await ensureTable(client);
  }
  let cursor;
  let pages = 0, received = 0, valid = 0, rejected = 0, saved = 0;
  let apiTotal = null;
  const seen = new Set();
  try {
    while (pages < MAX_PAGES) {
      const args = {
        code: CODE, geoLevel: GEO_LEVEL, dateMin: DATE_MIN, dateMax: DATE_MAX,
        txType: TX_TYPES, realtyType: REALTY_TYPES,
        sortBy: "date", sortOrder: "desc", size: PAGE_SIZE
      };
      if (cursor) args.searchAfter = cursor;
      const response = unwrap(await rpc("tools/call", {
        name: "search_transactions", arguments: args
      }, pages + 1));
      if (!response || !Array.isArray(response.data)) {
        throw new Error("Format inattendu : le champ data n'est pas un tableau.");
      }
      pages++;
      if (apiTotal === null) apiTotal = num(response.total);
      const items = response.data;
      received += items.length;
      const batch = [];
      for (const item of items) {
        const r = mapRecord(item);
        if (!validRecord(r)) { rejected++; continue; }
        if (seen.has(r.txId)) continue;
        seen.add(r.txId);
        valid++;
        if (WRITE) batch.push(r);
      }
      if (WRITE && batch.length) saved += await saveBatch(client, batch);
      console.log("Page", pages, ":", items.length, "résultats ; valides uniques", valid,
        "; enregistrés/actualisés", saved, "; rejetés qualité", rejected);
      const next = text(response.searchAfter);
      if (!items.length || !next || next === cursor) {
        cursor = null;
        break;
      }
      cursor = next;
    }
    console.log(JSON.stringify({
      mode: DRY_RUN ? "dry-run" : "staging-write",
      zone: { geoLevel: GEO_LEVEL, code: CODE },
      dateMin: DATE_MIN, dateMax: DATE_MAX, pageSize: PAGE_SIZE,
      pagesRequested: pages, maxPages: MAX_PAGES, estimatedCostEUR: Number((pages * 0.01).toFixed(2)),
      apiTotal, received, validUniqueInThisRun: valid, rejectedQuality: rejected,
      recordsUpserted: saved, hasMorePages: Boolean(cursor),
      note: "Import isolé : aucune table DVF existante ni moteur d'estimation modifié."
    }, null, 2));
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }
}
main().catch(error => {
  console.error("Import Immo Data échoué :", String(error.message || error));
  process.exitCode = 1;
});
