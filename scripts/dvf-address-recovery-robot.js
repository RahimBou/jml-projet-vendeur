#!/usr/bin/env node
"use strict";

/**
 * JML — robot de rapprochement d'adresses DVF, mode lecture seule.
 *
 * IMPORTANT:
 * - Commune obligatoire : aucune recherche sur tout le département sans filtre.
 * - Lit uniquement jml_data_sales_v3 et ne modifie aucune table.
 * - Télécharge les DVF officiels gratuits pour les années demandées.
 * - Ne propose une adresse que si le rapprochement est unique et suffisamment fort.
 * - Produit un rapport local privé ; ne publie/indexe pas les adresses.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' node scripts/dvf-address-recovery-robot.js --commune=08105 --dry-run
 *   DATABASE_URL='postgresql://...' node scripts/dvf-address-recovery-robot.js --commune=08105 --years=2021,2022,2023,2024,2025,2026 --out=/tmp/jml-address-recovery-08105.json
 *
 * Utiliser une copie/staging de la base pour le premier essai.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const readline = require("node:readline");

const communeCode = String(process.argv.find(x => x.startsWith("--commune="))?.split("=")[1] || "").trim();
const yearsArg = String(process.argv.find(x => x.startsWith("--years="))?.split("=")[1] || "2021,2022,2023,2024,2025,2026");
const years = [...new Set(yearsArg.split(",").map(Number).filter(y => Number.isInteger(y) && y >= 2021 && y <= 2026))].sort((a,b)=>a-b);
const outArg = process.argv.find(x => x.startsWith("--out="))?.slice(6);
const dryRun = process.argv.includes("--dry-run");
const BASE_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv";
const PRIVATE_DIR = path.resolve(path.join(os.tmpdir(), "jml-dvf-address-recovery"));

function parseCsvLine(line) {
  const out=[]; let cur="", quoted=false;
  for(let i=0;i<line.length;i++) {
    const ch=line[i];
    if(ch === '"') {
      if(quoted && line[i+1] === '"') {cur+='"';i++;}
      else quoted=!quoted;
    } else if(ch === "," && !quoted) {out.push(cur);cur="";}
    else cur+=ch;
  }
  out.push(cur); return out;
}
function text(v) { return String(v ?? "").trim(); }
function num(v) { const s=text(v); if(!s) return null; const n=Number(s.replace(",",".")); return Number.isFinite(n)?n:null; }
function norm(v) { return text(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function date(v) {
  const s=text(v);
  let m=s.match(/^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/);
  if(m) return m[3]+"-"+m[2]+"-"+m[1];
  return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:null;
}
function fingerprint(v) { return crypto.createHash("sha256").update(v).digest("hex"); }
function makeAddress(r) { return [r.number,r.suffix,r.street].filter(Boolean).join(" ").trim() || null; }

async function downloadYear(year) {
  const url = `${BASE_URL}/${year}/departements/08.csv.gz`;
  const response = await fetch(url, {headers:{Accept:"application/gzip","User-Agent":"JML-DVF-Address-Recovery/1.0"},signal:AbortSignal.timeout(180000)});
  if(response.status===404) return {year,url,unavailable:true};
  if(!response.ok) throw new Error(`DVF ${year}: HTTP ${response.status}`);
  const compressed=Buffer.from(await response.arrayBuffer());
  if(compressed.length<2 || compressed[0]!==0x1f || compressed[1]!==0x8b) throw new Error(`DVF ${year}: gzip invalide`);
  fs.mkdirSync(PRIVATE_DIR,{recursive:true,mode:0o700});
  const file=path.join(PRIVATE_DIR,`${year}-08.csv.gz`);
  fs.writeFileSync(file,compressed,{mode:0o600});
  return {year,url,file,sha256:fingerprint(compressed),bytes:compressed.length};
}

async function loadOfficialRows(year,file) {
  const input=fs.createReadStream(file).pipe(zlib.createGunzip());
  const rl=readline.createInterface({input,crlfDelay:Infinity});
  let headers=null, idx=null, rows=0;
  const result=[];
  for await (const line of rl) {
    if(!headers) {
      headers=parseCsvLine(line).map(x=>x.trim());
      idx=Object.fromEntries(headers.map((x,i)=>[x,i]));
      const required=["id_mutation","date_mutation","nature_mutation","valeur_fonciere","type_local","surface_reelle_bati","code_commune"];
      const missing=required.filter(k=>idx[k]===undefined);
      if(missing.length) throw new Error(`DVF ${year}: colonnes manquantes ${missing.join(", ")}`);
      continue;
    }
    if(!line) continue;
    const c=parseCsvLine(line);
    if(text(c[idx.code_commune])!==communeCode || text(c[idx.nature_mutation])!=="Vente") continue;
    const type=text(c[idx.type_local]);
    if(type!=="Maison" && type!=="Appartement") continue;
    const row={
      year, mutationId:text(c[idx.id_mutation]) || null,
      saleDate:date(c[idx.date_mutation]), price:num(c[idx.valeur_fonciere]),
      propertyType:type, surface:num(c[idx.surface_reelle_bati]),
      rooms:num(c[idx.nombre_pieces_principales]), land:num(c[idx.surface_terrain]),
      parcel:text(c[idx.id_parcelle]) || null, communeCode:text(c[idx.code_commune]),
      communeName:text(c[idx.nom_commune]) || null,
      postalCode:text(c[idx.code_postal]) || null,
      address:makeAddress({number:text(c[idx.adresse_numero]),suffix:text(c[idx.adresse_suffixe]),street:text(c[idx.adresse_nom_voie])}),
      latitude:num(c[idx.latitude]),longitude:num(c[idx.longitude])
    };
    if(row.address) result.push(row);
    rows++;
  }
  return {rows:result,sourceRows:rows};
}

function scoreCandidate(target,candidate) {
  let score=0; const evidence=[];
  if(target.saleDate && candidate.saleDate===target.saleDate) {score+=5;evidence.push("date exacte");}
  if(target.propertyType && norm(target.propertyType)===norm(candidate.propertyType)) {score+=3;evidence.push("type exact");}
  if(target.price!=null && candidate.price!=null && Math.abs(target.price-candidate.price)<=1) {score+=5;evidence.push("prix exact");}
  if(target.surface!=null && candidate.surface!=null) {
    const diff=Math.abs(target.surface-candidate.surface);
    if(diff<=0.5) {score+=4;evidence.push("surface à 0,5 m² près");}
    else if(diff<=2) {score+=2;evidence.push("surface à 2 m² près");}
  }
  if(target.rooms!=null && candidate.rooms!=null && target.rooms===candidate.rooms) {score+=1;evidence.push("pièces concordantes");}
  if(target.land!=null && candidate.land!=null && Math.abs(target.land-candidate.land)<=5) {score+=1;evidence.push("terrain concordant");}
  if(target.parcel && candidate.parcel && norm(target.parcel)===norm(candidate.parcel)) {score+=8;evidence.push("parcelle exacte");}
  return {score,evidence};
}

function recover(targets,officialRows) {
  const output=[];
  for(const target of targets) {
    const ranked=officialRows.map(candidate=>({candidate,...scoreCandidate(target,candidate)}))
      .filter(x=>x.score>=17)
      .sort((a,b)=>b.score-a.score);
    const best=ranked[0], second=ranked[1];
    const unique=Boolean(best && (!second || best.score>second.score));
    const hasStrongKey=Boolean(best && best.evidence.includes("date exacte") && best.evidence.includes("prix exact") &&
      (best.evidence.some(e=>e.startsWith("surface")) || best.evidence.includes("parcelle exacte")));
    const accepted=Boolean(unique && hasStrongKey && best.candidate.address);
    output.push({
      sourceRecordKey:target.sourceRecordKey, sourceYear:target.year, saleDate:target.saleDate,
      communeCode:target.communeCode, propertyType:target.propertyType, price:target.price,
      surface:target.surface, status:accepted?"unique_match":ranked.length?"ambiguous_or_weak":"not_found",
      confidence:accepted?"high":ranked.length?"review":"none",
      candidateCount:ranked.length,
      recovered:accepted?{
        address:best.candidate.address,postalCode:best.candidate.postalCode,
        communeName:best.candidate.communeName,parcel:best.candidate.parcel,
        latitude:best.candidate.latitude,longitude:best.candidate.longitude,
        officialMutationId:best.candidate.mutationId,officialSourceYear:best.candidate.year,
        matchScore:best.score,evidence:best.evidence
      }:null,
      reviewCandidates:!accepted?ranked.slice(0,3).map(x=>({
        address:x.candidate.address,postalCode:x.candidate.postalCode,price:x.candidate.price,
        surface:x.candidate.surface,saleDate:x.candidate.saleDate,parcel:x.candidate.parcel,
        score:x.score,evidence:x.evidence
      })):undefined
    });
  }
  return output;
}

async function main() {
  if(!/^\d{5}$/.test(communeCode) || !communeCode.startsWith("08")) throw new Error("--commune=CODE_INSEE obligatoire (5 chiffres, Ardennes uniquement).");
  if(!years.length) throw new Error("--years doit contenir au moins une année entre 2021 et 2026.");
  if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL manquante. Utiliser une copie/staging, pas la base de production.");
  if(!dryRun && !outArg) throw new Error("Pour éviter toute écriture implicite, fournissez --out=... ; ce robot ne modifie jamais la base.");
  const {Pool}=require("pg");
  const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==="false"?false:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:15000});
  let targets=[];
  try {
    await pool.query("BEGIN READ ONLY");
    const q=await pool.query(`
      SELECT source_record_key, sale_date, property_type, price,
             habitable_area AS surface, room_count AS rooms, land_area AS land,
             commune_code, year, NULLIF(BTRIM(address),'') AS address,
             NULLIF(BTRIM(postal_code),'') AS postal_code
      FROM public.jml_data_sales_v3
      WHERE comparable_status='historical_no_address'
        AND commune_code=$1
        AND (address IS NULL OR BTRIM(address)='')
        AND property_type IN ('Maison','Appartement')
        AND sale_date IS NOT NULL AND price>0 AND habitable_area>0
      ORDER BY sale_date DESC, source_record_key
    `,[communeCode]);
    targets=q.rows.map(r=>({
      sourceRecordKey:r.source_record_key,saleDate:r.sale_date?String(r.sale_date).slice(0,10):null,
      propertyType:r.property_type,price:r.price==null?null:Number(r.price),
      surface:r.surface==null?null:Number(r.surface),rooms:r.rooms==null?null:Number(r.rooms),
      land:r.land==null?null:Number(r.land),communeCode:r.commune_code,year:Number(r.year),
      postalCode:r.postal_code||null
    }));
    await pool.query("COMMIT");
  } catch(e) {
    try { await pool.query("ROLLBACK"); } catch {}
    throw e;
  } finally { await pool.end(); }

  const report={robot:"jml-dvf-address-recovery",generatedAt:new Date().toISOString(),
    department:"08",communeCode,years,source:"DVF officielle DGFiP via data.gouv.fr",
    databaseMode:"READ ONLY",databaseWrites:false,productionTablesChanged:false,
    note:"Une adresse n'est retenue que si le candidat est unique, avec date et prix exacts et surface ou parcelle concordante. Les autres cas restent à vérifier manuellement.",
    targetRows:targets.length,downloads:[],matches:[]};
  const all=[];
  for(const year of years) {
    const d=await downloadYear(year);
    if(d.unavailable) {report.downloads.push({year,status:"unavailable",sourceUrl:d.url});continue;}
    const parsed=await loadOfficialRows(year,d.file);
    all.push(...parsed.rows);
    report.downloads.push({year,status:"ok",sourceUrl:d.url,sha256:d.sha256,bytes:d.bytes,communeRows:parsed.sourceRows,rowsWithAddress:parsed.rows.length});
  }
  report.matches=recover(targets,all);
  report.summary={
    uniqueHighConfidence:report.matches.filter(x=>x.status==="unique_match").length,
    ambiguousOrWeak:report.matches.filter(x=>x.status==="ambiguous_or_weak").length,
    notFound:report.matches.filter(x=>x.status==="not_found").length,
    targetsWithNoSourceYear:report.matches.filter(x=>!years.includes(x.sourceYear)).length
  };
  const destination=path.resolve(outArg || path.join(PRIVATE_DIR,`recovery-${communeCode}.json`));
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  fs.writeFileSync(destination,JSON.stringify(report,null,2)+"\n",{encoding:"utf8",mode:0o600});
  console.log(JSON.stringify({ ...report, matches:undefined, reportPath:destination },null,2));
  console.log(`Rapport détaillé privé : ${destination}`);
}
if(require.main===module) main().catch(e=>{console.error("DVF address recovery stopped:",e.message);process.exitCode=1;});
module.exports={parseCsvLine,norm,date,scoreCandidate,recover};
