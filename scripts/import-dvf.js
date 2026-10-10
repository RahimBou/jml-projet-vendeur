const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
if (!DATABASE_URL) throw new Error("DATABASE_URL manquante.");

const YEARS = String(process.env.DVF_IMPORT_YEARS || "2026,2025,2024,2023")
  .split(",").map(x => Number(x.trim())).filter(Number.isInteger);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 15000
});

function parseCsvLine(line){
  const out=[]; let cur="", quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){cur+='"';i++;}
      else quoted=!quoted;
    } else if(ch===","&&!quoted){out.push(cur);cur="";}
    else cur+=ch;
  }
  out.push(cur);
  return out;
}

function num(v){
  // Une cellule vide DVF doit rester inconnue (null), jamais devenir 0.
  // Sinon pièces/surface de terrain absentes sont stockées comme des valeurs réelles.
  const raw=String(v??"").trim();
  if(!raw) return null;
  const n=Number(raw.replace(",", "."));
  return Number.isFinite(n)?n:null;
}
function text(v){ return String(v??"").trim() || null; }

async function importYear(client, year){
  const url="https://files.data.gouv.fr/geo-dvf/latest/csv/"+year+"/departements/08.csv.gz";
  console.log("DVF: téléchargement",year,url);
  const response=await fetch(url,{headers:{"Accept":"application/gzip","User-Agent":"JML-Projet-Vendeur-DVF-Importer/1.0"},signal:AbortSignal.timeout(120000)});
  if(!response.ok) throw new Error("DVF "+year+" HTTP "+response.status);
  const raw=zlib.gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const lines=raw.split(/\r?\n/).filter(Boolean);
  if(!lines.length) return 0;
  const header=parseCsvLine(lines[0]).map(v=>v.trim());
  const idx=Object.fromEntries(header.map((v,i)=>[v,i]));
  const required=["id_mutation","date_mutation","nature_mutation","valeur_fonciere","type_local","surface_reelle_bati","latitude","longitude","code_commune","nom_commune"];
  for(const key of required) if(idx[key]===undefined) throw new Error("Colonne DVF absente: "+key);

  await client.query("BEGIN");
  await client.query("DELETE FROM jml_dvf_sales WHERE source_year=$1",[year]);

  // On analyse toutes les lignes de la mutation avant de retenir une maison/appartement.
  // La valeur foncière est celle de la mutation : si plusieurs biens sont présents,
  // l'attribuer à chaque ligne fausse le prix au m². En cas d'ambiguïté, on exclut
  // toute la mutation du moteur de prix plutôt que d'inventer une ventilation.
  const transactionRows=new Map();
  let invalidRows=0;
  for(let i=1;i<lines.length;i++){
    const r=parseCsvLine(lines[i]);
    if(r[idx.nature_mutation]!=="Vente") continue;
    const mutationId=text(r[idx.id_mutation])||[
      r[idx.date_mutation],r[idx.valeur_fonciere],r[idx.adresse_numero],
      r[idx.adresse_nom_voie],r[idx.code_commune]
    ].join("|");
    const type=text(r[idx.type_local])||"Sans local";
    const price=num(r[idx.valeur_fonciere]);
    const surface=num(r[idx.surface_reelle_bati]);
    const landSurface=num(r[idx.surface_terrain]);
    const lat=num(r[idx.latitude]), lon=num(r[idx.longitude]);
    const address=[r[idx.adresse_numero],r[idx.adresse_suffixe],r[idx.adresse_nom_voie]]
      .map(text).filter(Boolean).join(" ")||null;
    const row={
      mutation_id:mutationId,
      sale_date:text(r[idx.date_mutation]),
      property_type:type,
      price,surface,
      rooms:num(r[idx.nombre_pieces_principales]),
      land_surface:landSurface,
      latitude:lat,longitude:lon,
      address,
      street:text(r[idx.adresse_nom_voie]),
      postal_code:text(r[idx.code_postal]),
      commune_code:text(r[idx.code_commune]),
      commune_name:text(r[idx.nom_commune]),
      parcel_id:text(r[idx.id_parcelle]),
      source_year:year
    };
    if(!transactionRows.has(mutationId)) transactionRows.set(mutationId,[]);
    transactionRows.get(mutationId).push(row);
  }

  const data=[];
  let ambiguousMutations=0;
  let collapsedDuplicateRows=0;
  for(const [mutationId,rows] of transactionRows){
    // Le numéro de parcelle est volontairement exclu de cette signature :
    // une même maison peut toucher plusieurs parcelles cadastrales.
    const signatures=new Map();
    for(const r of rows){
      const signature=[
        r.property_type,r.surface??"",r.rooms??"",r.land_surface??"",
        String(r.address||"").normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()
      ].join("|");
      if(!signatures.has(signature)) signatures.set(signature,r);
      else collapsedDuplicateRows++;
    }
    // Plusieurs lignes réellement distinctes dans une mutation : prix total non
    // ventilable avec certitude. Ne pas réutiliser ce prix sur chaque logement.
    if(signatures.size!==1){
      ambiguousMutations++;
      continue;
    }
    const r=[...signatures.values()][0];
    if(!["Maison","Appartement"].includes(r.property_type)) continue;
    if(!(r.price>0&&r.surface>0&&r.latitude!=null&&r.longitude!=null)){
      invalidRows++;
      continue;
    }
    data.push(r);
  }
  console.log("DVF "+year+": "+transactionRows.size+" mutations analysées; "+
    ambiguousMutations+" mutations multi-lignes ambiguës exclues; "+
    collapsedDuplicateRows+" lignes répétées regroupées; "+invalidRows+
    " lignes résidentielles incomplètes exclues.");
  console.log("DVF "+year+" contrôle qualité: "+data.length+
    " mutations résidentielles retenues; "+(transactionRows.size-data.length)+
    " mutations non retenues au total (ambiguïté, type non résidentiel ou données insuffisantes).");
  const chunk=500;
  for(let i=0;i<data.length;i+=chunk){
    const part=data.slice(i,i+chunk);
    const values=[], params=[];
    part.forEach((r,k)=>{
      const b=k*18;
      values.push("(" + Array.from({length:18},(_,j)=>"$"+(b+j+1)).join(",") + ")");
      params.push(r.mutation_id,r.sale_date,r.property_type,r.price,r.surface,r.rooms,r.land_surface,r.latitude,r.longitude,r.address,r.street,r.postal_code,r.commune_code,r.commune_name,r.parcel_id,r.source_year,r.price/r.surface,"DVF");
    });
    await client.query(`INSERT INTO jml_dvf_sales
      (mutation_id,sale_date,property_type,price,surface,rooms,land_surface,latitude,longitude,address,street,postal_code,commune_code,commune_name,parcel_id,source_year,price_per_m2,source)
      VALUES ${values.join(",")}
      ON CONFLICT DO NOTHING`,params);
    process.stdout.write("\rDVF "+year+": "+Math.min(i+chunk,data.length)+"/"+data.length);
  }
  await client.query("COMMIT");
  console.log("\nDVF "+year+": "+data.length+" mutations résidentielles importées.");
  return data.length;
}

async function main(){
  const client=await pool.connect();
  try{
    await client.query(`CREATE TABLE IF NOT EXISTS jml_dvf_sales (
      id BIGSERIAL PRIMARY KEY,
      mutation_id TEXT NOT NULL,
      sale_date DATE,
      property_type TEXT NOT NULL,
      price NUMERIC NOT NULL,
      surface NUMERIC NOT NULL,
      rooms NUMERIC,
      land_surface NUMERIC,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      address TEXT,
      street TEXT,
      postal_code TEXT,
      commune_code TEXT,
      commune_name TEXT,
      parcel_id TEXT,
      source_year INTEGER NOT NULL,
      price_per_m2 NUMERIC NOT NULL,
      source TEXT NOT NULL DEFAULT 'DVF',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(mutation_id,property_type,price,surface,address,parcel_id)
    )`);
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvf_commune_date ON jml_dvf_sales(commune_code,sale_date DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvf_geo_date ON jml_dvf_sales(latitude,longitude,sale_date DESC)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_jml_dvf_type_surface ON jml_dvf_sales(property_type,surface)");

    // Inclure l'année source dans l'unicité évite qu'une ligne importée une
    // année soit confondue avec une ligne identique d'une autre année.
    const oldUnique = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid='jml_dvf_sales'::regclass AND contype='u'
        AND pg_get_constraintdef(oid) =
          'UNIQUE (mutation_id, property_type, price, surface, address, parcel_id)'
    `);
    for (const row of oldUnique.rows) {
      await client.query(`ALTER TABLE jml_dvf_sales DROP CONSTRAINT "${row.conname}"`);
      console.log("DVF migration: ancienne contrainte unique retirée:", row.conname);
    }
    const newUnique = await client.query(`
      SELECT 1 FROM pg_constraint
      WHERE conrelid='jml_dvf_sales'::regclass
        AND conname='jml_dvf_sales_source_year_unique'
    `);
    if (!newUnique.rowCount) {
      await client.query(`
        ALTER TABLE jml_dvf_sales
        ADD CONSTRAINT jml_dvf_sales_source_year_unique
        UNIQUE (source_year, mutation_id, property_type, price, surface, address, parcel_id)
      `);
      console.log("DVF migration: unicité désormais limitée à une même année source.");
    }

    const failures=[];
    let successfulYears=0;
    for(const year of YEARS){
      try{
        await importYear(client,year);
        successfulYears++;
      } catch(error){
        try{ await client.query("ROLLBACK"); }catch(_){}
        const message=String(error?.message||error);
        failures.push({year,message});
        console.error("DVF "+year+" ÉCHEC:",message);
      }
    }
    // Le workflow ne doit jamais afficher une réussite silencieuse si une
    // année demandée n'a pas pu être actualisée. Les années suivantes sont
    // tout de même tentées pour éviter de perdre une mise à jour partielle.
    if(failures.length){
      throw new Error("Import DVF incomplet. Années en échec: "+
        failures.map(f=>f.year+" ("+f.message+")").join("; "));
    }
    if(!successfulYears) throw new Error("Aucune année DVF n'a été importée.");
    const count=await client.query("SELECT COUNT(*)::int AS count, MAX(imported_at) AS imported_at FROM jml_dvf_sales");
    console.log("DVF import terminé:",count.rows[0]);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async e=>{ console.error("DVF import FAILED:",e); try{await pool.end();}catch(_){} process.exit(1); });
