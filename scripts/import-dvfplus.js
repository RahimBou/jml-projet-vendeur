const fs = require("fs");
const readline = require("readline");
const { Pool } = require("pg");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const CSV_PATH = String(process.env.DVF_PLUS_CSV_PATH || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL manquante.");
if (!CSV_PATH) throw new Error("DVF_PLUS_CSV_PATH manquante : chemin du fichier dvf_plus.csv décompressé.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15000
});

function parseDelimitedLine(line, delimiter = "|") {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const result = Number(raw.replace(",", "."));
  return Number.isFinite(result) ? result : null;
}

function cleanText(value) {
  return String(value ?? "").trim() || null;
}

// Conversion inverse Lambert-93 (EPSG:2154) vers WGS84.
// Les coordonnées sources DVF+ sont en mètres, pas en latitude/longitude.
function lambert93ToWgs84(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const a = 6378137;
  const e = 0.0818191910428158;
  const n = 0.725607765053267;
  const c = 11754255.426096;
  const xs = 700000;
  const ys = 12655612.049876;
  const lon0 = 3 * Math.PI / 180;
  const dx = x - xs;
  const dy = ys - y;
  const rho = Math.hypot(dx, dy);
  if (!Number.isFinite(rho) || rho <= 0) return null;
  const gamma = Math.atan2(dx, dy);
  const lon = lon0 + gamma / n;
  const t = Math.pow(rho / c, 1 / n);
  let lat = Math.PI / 2 - 2 * Math.atan(t);
  for (let i = 0; i < 12; i++) {
    const sinLat = Math.sin(lat);
    const factor = Math.pow((1 - e * sinLat) / (1 + e * sinLat), e / 2);
    const next = Math.PI / 2 - 2 * Math.atan(t * factor);
    if (Math.abs(next - lat) < 1e-12) { lat = next; break; }
    lat = next;
  }
  const latitude = lat * 180 / Math.PI;
  const longitude = lon * 180 / Math.PI;
  if (latitude < 41 || latitude > 52 || longitude < -6 || longitude > 10) return null;
  return { latitude, longitude };
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) throw new Error("Fichier introuvable : " + CSV_PATH);
  const client = await pool.connect();
  const stats = {
    linesRead: 0, departmentRows: 0, residentialSales: 0,
    imported: 0, rejectedNature: 0, rejectedType: 0,
    rejectedComplex: 0, rejectedPriceSurface: 0, rejectedCoordinates: 0
  };
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jml_dvfplus_sales (
        id BIGSERIAL PRIMARY KEY,
        mutation_id TEXT NOT NULL,
        sale_date DATE,
        source_year INTEGER NOT NULL,
        property_type TEXT NOT NULL CHECK (property_type IN ('Maison','Appartement')),
        price NUMERIC NOT NULL CHECK (price > 0),
        surface NUMERIC NOT NULL CHECK (surface > 0),
        price_per_m2 NUMERIC NOT NULL CHECK (price_per_m2 > 0),
        rooms NUMERIC,
        land_surface NUMERIC,
        latitude DOUBLE PRECISION NOT NULL,
        longitude DOUBLE PRECISION NOT NULL,
        commune_code TEXT,
        parcel_ids TEXT,
        comparable_eligible BOOLEAN NOT NULL DEFAULT TRUE,
        exclusion_reason TEXT,
        source TEXT NOT NULL DEFAULT 'DVF+ Cerema',
        imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (mutation_id, source_year)
      )
    `);
    await client.query("ALTER TABLE jml_dvfplus_sales ADD COLUMN IF NOT EXISTS comparable_eligible BOOLEAN NOT NULL DEFAULT TRUE");
    await client.query("ALTER TABLE jml_dvfplus_sales ADD COLUMN IF NOT EXISTS exclusion_reason TEXT");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_geo_date ON jml_dvfplus_sales(latitude, longitude, sale_date DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_type_surface ON jml_dvfplus_sales(property_type, surface)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvfplus_commune_date ON jml_dvfplus_sales(commune_code, sale_date DESC)");

    const input = fs.createReadStream(CSV_PATH, { encoding: "utf8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let indexes = null;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await client.query("BEGIN");
      try {
        // La clé de dédoublonnage est mutation_id + année, jamais l'adresse seule.
        const uniqueBatch = [...new Map(batch.map(row => [String(row[0]) + "::" + String(row[2]), row])).values()];
        const values = [];
        const rowsSql = uniqueBatch.map((row, rowIndex) => {
          const offset = rowIndex * 15;
          values.push(...row);
          return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},$${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},$${offset+11},$${offset+12},$${offset+13},$${offset+14},$${offset+15},'DVF+ Cerema')`;
        });
        await client.query(`
          INSERT INTO jml_dvfplus_sales
            (mutation_id, sale_date, source_year, property_type, price, surface,
             price_per_m2, rooms, land_surface, latitude, longitude, commune_code, parcel_ids, comparable_eligible, exclusion_reason, source)
          VALUES ${rowsSql.join(",")}
          ON CONFLICT (mutation_id, source_year) DO UPDATE SET
            sale_date=EXCLUDED.sale_date, property_type=EXCLUDED.property_type,
            price=EXCLUDED.price, surface=EXCLUDED.surface,
            price_per_m2=EXCLUDED.price_per_m2, rooms=EXCLUDED.rooms,
            land_surface=EXCLUDED.land_surface, latitude=EXCLUDED.latitude,
            longitude=EXCLUDED.longitude, commune_code=EXCLUDED.commune_code,
            parcel_ids=EXCLUDED.parcel_ids, comparable_eligible=EXCLUDED.comparable_eligible,
            exclusion_reason=EXCLUDED.exclusion_reason, imported_at=NOW()
        `, values);
        stats.imported += uniqueBatch.length;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      batch = [];
      console.log("DVF+ : lignes fiables traitées =", stats.imported);
    };

    for await (const line of rl) {
      if (!line) continue;
      stats.linesRead++;
      const fields = parseDelimitedLine(line);
      if (!indexes) {
        indexes = Object.fromEntries(fields.map((name, i) => [name.trim(), i]));
        const required = ["idmutation","datemut","anneemut","coddep","libnatmut","valeurfonc","nbcomm","nbparmut","nblocmut","sbatmai","sbatapt","libtypbien","geompar_x","geompar_y","l_codinsee","l_idparmut","nbmai1pp","nbapt1pp","sterr"];
        for (const key of required) if (indexes[key] === undefined) throw new Error("Colonne DVF+ absente : " + key);
        continue;
      }
      const get = key => fields[indexes[key]] ?? "";
      if (String(get("coddep")).trim().padStart(2, "0") !== "08") continue;
      stats.departmentRows++;
      if (cleanText(get("libnatmut")) !== "Vente") { stats.rejectedNature++; continue; }
      const label = cleanText(get("libtypbien"));
      let propertyType, surface;
      if (label === "UNE MAISON") {
        propertyType = "Maison";
        surface = num(get("sbatmai"));
      } else if (label === "UN APPARTEMENT") {
        propertyType = "Appartement";
        surface = num(get("sbatapt"));
      } else { stats.rejectedType++; continue; }

      // Les mutations complexes sont conservées, mais exclues des comparables :
      // leur prix global ne doit pas être attribué à chaque appartement/local.
      const price = num(get("valeurfonc"));
      if (!(price > 0 && surface > 0)) { stats.rejectedPriceSurface++; continue; }
      const xy = lambert93ToWgs84(num(get("geompar_x")), num(get("geompar_y")));
      if (!xy) { stats.rejectedCoordinates++; continue; }
      const mutationId = cleanText(get("idmutation"));
      const sourceYear = num(get("anneemut"));
      const saleDate = cleanText(get("datemut"));
      if (!mutationId || !Number.isInteger(sourceYear) || !saleDate) {
        stats.rejectedPriceSurface++; continue;
      }
      const rawParcels = cleanText(get("l_idparmut"));
      const complexity = [];
      if (num(get("nbcomm")) > 1) complexity.push("plusieurs_communes");
      // Pour les appartements en copropriété, nbparmut peut valoir 0 :
      // zéro signifie ici « aucune parcelle mutée renseignée », pas « vente multiple ».
      if (num(get("nbparmut")) > 1) complexity.push("plusieurs_parcelles");
      if (num(get("nblocmut")) > 1) complexity.push("plusieurs_locaux");
      const comparableEligible = complexity.length === 0;
      if (!comparableEligible) stats.rejectedComplex++;
      batch.push([
        mutationId, saleDate, sourceYear, propertyType, price, surface,
        price / surface, null, num(get("sterr")), xy.latitude, xy.longitude,
        cleanText(get("l_codinsee"))?.split(",")[0]?.trim() || null, rawParcels,
        comparableEligible, complexity.join(",") || null
      ]);
      stats.residentialSales++;
      if (batch.length >= 250) await flush();
    }
    await flush();
    const coverage = await client.query(`
      SELECT source_year, property_type, COUNT(*)::int AS sales,
             COUNT(*) FILTER (WHERE comparable_eligible)::int AS eligible_comparables,
             COUNT(*) FILTER (WHERE NOT comparable_eligible)::int AS retained_but_excluded_from_comparables,
             MIN(sale_date)::text AS first_sale, MAX(sale_date)::text AS last_sale,
             ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2)::numeric, 2) AS median_price_per_m2
      FROM jml_dvfplus_sales
      GROUP BY source_year, property_type
      ORDER BY source_year, property_type
    `);
    console.log("DVF+ IMPORT SUMMARY", JSON.stringify({
      ...stats,
      coverage: coverage.rows
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async error => {
  console.error("DVF+ IMPORT FAILED:", error.message || error);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
