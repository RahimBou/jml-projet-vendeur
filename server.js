const express = require("express");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");
const { Readable } = require("stream");
const { Pool } = require("pg");
const crypto = require("crypto");
const registerPublicEventsRoute = require("./events");
const { registerGoogleCalendarRoutes, getGoogleCalendarBusy } = require("./google-calendar");
const { getPublicMarketBenchmarks } = require("./external-estimators");

const app = express();
app.set("trust proxy", 1);


// Réseau externe : certaines API publiques peuvent fermer brutalement leur flux
// (ECONNRESET / AbortError / "terminated"). On journalise ces erreurs réseau
// transitoires sans faire tomber tout le serveur Render.
process.on("uncaughtException",(error)=>{
  const code=String(error?.code||error?.cause?.code||"");
  const message=String(error?.message||error||"");
  const transient=code==="ECONNRESET" || code==="UND_ERR_SOCKET" || /terminated|aborted due to timeout/i.test(message);
  if(transient){
    console.warn("JML réseau externe transitoire — processus conservé:",message,code);
    return;
  }
  console.error("JML uncaughtException:",error);
  process.exit(1);
});
process.on("unhandledRejection",(reason)=>{
  const code=String(reason?.code||reason?.cause?.code||"");
  const message=String(reason?.message||reason||"");
  const transient=code==="ECONNRESET" || code==="UND_ERR_SOCKET" || /terminated|aborted due to timeout/i.test(message);
  if(transient){
    console.warn("JML rejet réseau externe transitoire — processus conservé:",message,code);
    return;
  }
  console.error("JML unhandledRejection:",reason);
});

const PORT = Number(process.env.PORT || 10000);
const VERSION = "3.9.8";
const BUILD_MARKER = "dvf-postgres-comparables-robust-v12-dpe03existant-multifulltext-v14-roads-v15-ai-v16-google-calendar-v17-temporal-revaluation-v18-independent-control-v19-hybrid-external-market";
const DVF_LATEST_YEAR = Number(process.env.CURRENT_DATA_YEAR || 2025);
const GOOGLE_STREETVIEW_API_KEY = String(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_STREETVIEW_API_KEY || "").trim();

app.disable("x-powered-by");

// Durcissement HTTP pour l'espace professionnel et ses données commerciales.
app.use((req,res,next)=>{
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
  if(isSecureRequest(req)){
    res.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");
  }
  if(req.path.startsWith("/api/")){
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
  }
  next();
});
app.get("/health", (req, res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).json({
    ok:true,
    service:"jml-projet-vendeur",
    version:VERSION,
    build:BUILD_MARKER,
    sellerSpace:true,
    persistentDashboard:true
  });
});
app.get("/api/bpe-status", async (req,res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  if(!pool) return res.status(200).json({ok:true,ready:false,total:0,reason:"database_unavailable"});
  try{
    const result=await db("SELECT COUNT(*)::int AS total, COUNT(DISTINCT commune_code)::int AS communes, MAX(imported_at) AS imported_at FROM jml_bpe_assets WHERE year=2025 AND commune_code LIKE '08%'",[]);
    const row=result.rows[0]||{};
    res.status(200).json({ok:true,ready:Number(row.total||0)>0,total:Number(row.total||0),communes:Number(row.communes||0),importedAt:row.imported_at||null,source:"INSEE BPE 2025",department:"08"});
  }catch(error){
    res.status(200).json({ok:false,ready:false,total:0,reason:String(error?.message||error)});
  }
});
app.get("/api/territory-version", (req,res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.status(200).json({
    ok:true,
    version:VERSION,
    build:BUILD_MARKER,
    route:"/api/territory-summary",
    expected:"inline-seller-reference"
  });
});
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "pro-login.html")));
app.get("/projet-vendeur", (req, res) => res.sendFile(path.join(__dirname, "public", "projet-vendeur.html")));
app.get("/espace-vendeur/:token", (req, res) => res.sendFile(path.join(__dirname, "public", "espace-vendeur.html")));
app.get("/facebook", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  res.redirect(302, `/projet-vendeur${qs}`);
});
app.use((req,res,next) => {
  if (req.path.endsWith(".html") || req.path === "/") {
    res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma","no-cache");
    res.setHeader("Expires","0");
  }
  next();
});
app.get(["/vendeur-secteur","/vendeur-secteur.html"], (req,res) => {
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  res.setHeader("Expires","0");
  res.sendFile(path.join(__dirname, "public", "vendeur-secteur.html"));
});
app.use(express.static(path.join(__dirname, "public"), { index: false, extensions: ["html"], etag: false, lastModified: false }));

const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 10000
}) : null;

const adminSessions = new Map();
const adminLoginAttempts = new Map();
let dbReady = false;
const ADMIN_PASSWORD = String(process.env.JML_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "").trim();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_ATTEMPTS = 8;
function getCookie(req,name){
  const raw=String(req.headers.cookie||"");
  const part=raw.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  if(!part) return "";
  try{return decodeURIComponent(part.slice(name.length+1));}catch{return "";}
}
function isSecureRequest(req){
  const proto=String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim().toLowerCase();
  return req.secure===true || proto==="https";
}
function setAdminSessionCookie(res,req,token,maxAge=Math.floor(ADMIN_SESSION_TTL_MS/1000)){
  const parts=["jml_admin_session="+encodeURIComponent(token),"Path=/","HttpOnly","SameSite=Strict","Max-Age="+maxAge];
  if(isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie",parts.join("; "));
}
function createAdminSessionToken(){
  const expiresAt=Date.now()+ADMIN_SESSION_TTL_MS;
  const payload=String(expiresAt);
  const sig=crypto.createHmac("sha256",ADMIN_PASSWORD).update(payload).digest("hex");
  return payload+"."+sig;
}
function isAdminAuthenticated(req){
  const token=getCookie(req,"jml_admin_session");
  if(!token||!ADMIN_PASSWORD)return false;
  const parts=String(token).split(".");
  if(parts.length!==2)return false;
  const expiresAt=Number(parts[0]), sig=String(parts[1]||"");
  if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()||!/^[a-f0-9]{64}$/i.test(sig))return false;
  const expected=crypto.createHmac("sha256",ADMIN_PASSWORD).update(String(expiresAt)).digest("hex");
  try{return crypto.timingSafeEqual(Buffer.from(sig,"hex"),Buffer.from(expected,"hex"));}catch{return false;}
}
function requireAdminOr401(req,res){
  if(!ADMIN_PASSWORD) return apiError(res,503,"JML-AUTH-001","Accès professionnel non configuré. Ajoutez JML_ADMIN_PASSWORD dans Render.");
  if(!isAdminAuthenticated(req)){res.status(401).json({ok:false,code:"JML-AUTH-002",error:"Authentification professionnelle requise."});return false;}
  return true;
}

app.get("/espace-pro",(req,res)=>{
  if(!isAdminAuthenticated(req)) return res.redirect(302,"/pro-login");
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.get("/index.html",(req,res)=>{
  if(!isAdminAuthenticated(req)) return res.redirect(302,"/pro-login");
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(__dirname,"public","index.html"));
});

registerGoogleCalendarRoutes(app, { pool, isAdminAuthenticated }).catch(error => {
  console.warn("JML Google Calendar routes init:", error?.message || error);
});

const memory = { prospects: new Map(), leads: new Map(), sellerSpaces: new Map() };
const clean = (v, max = 500) => String(v ?? "").trim().slice(0, max);
function stripHtml(value){
  let s=String(value||"");
  s=s.split("<script").join(" ").split("</script>").join(" ");
  s=s.split("<style").join(" ").split("</style>").join(" ");
  s=s.replace(/<[^>]*>/g," ");
  s=s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"');
  s=s.replace(/&#39;|&apos;/gi,"'");
  return s.replace(/\\s+/g," ").trim();
}
registerPublicEventsRoute(app, clean);

const territoryAssetCache = new Map();
const majorRoadCache = new Map();

async function getEducationAssets(lat,lon,communeCode){
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return [];
  const where=communeCode
    ? 'code_commune="'+String(communeCode).replace(/"/g,'')+'" AND etat_etablissement=1'
    : "";
  const url="https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-adresse-et-geolocalisation-etablissements-premier-et-second-degre/records/?lang=fr&limit=100&offset=0"+(where?"&where="+encodeURIComponent(where):"");
  const response=await fetch(url,{headers:{"User-Agent":"JML-Projet-Vendeur/3.4.6","Accept":"application/json"},signal:AbortSignal.timeout(7000)});
  if(!response.ok) throw new Error("Education API HTTP "+response.status);
  const payload=await response.json();
  const rows=Array.isArray(payload?.results)?payload.results:[];
  return rows.map(x=>{
    const la=Number(x.latitude),lo=Number(x.longitude);
    if(!Number.isFinite(la)||!Number.isFinite(lo)) return null;
    const d=haversineKm({lat,lon},{lat:la,lon:lo});
    return d==null?null:{name:x.appellation_officielle||x.denomination_principale||"Établissement scolaire",distanceKm:Number(d.toFixed(2)),type:x.nature_uai_libe||"Établissement",students:x.nombre_eleves??null,source:"Éducation nationale"};
  }).filter(Boolean).filter(x=>x.distanceKm<=10).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,12);
}

const SELLER_BPE_TYPES = {
  daily: {
    label:"Commerces du quotidien",
    codes:{B101:"Hypermarché",B102:"Supermarché",B103:"Grande surface de bricolage",B201:"Supérette",B202:"Épicerie",B203:"Boulangerie",B204:"Boucherie / charcuterie",B316:"Station-service"}
  },
  health: {
    label:"Santé de proximité",
    codes:{D201:"Médecin généraliste",D221:"Chirurgien-dentiste",D232:"Infirmier",D233:"Masseur-kinésithérapeute",D307:"Pharmacie",D302:"Laboratoire d'analyses"}
  },
  family: {
    label:"Famille & éducation",
    codes:{D502:"Crèche",C107:"École maternelle",C108:"École primaire",C109:"École élémentaire",C201:"Collège",C301:"Lycée général / technologique",C302:"Lycée professionnel"}
  },
  leisure: {
    label:"Loisirs & vie locale",
    codes:{F102:"Boulodrome",F103:"Tennis",F109:"Parcours sportif / santé",F111:"Terrain ou plateau multisports",F113:"Terrain de grands jeux",F117:"Roller / skate / vélo",F307:"Bibliothèque",F303:"Cinéma",F116:"Salle multisports",F121:"Salle multisports"}
  }
};
const SELLER_BPE_CODE_TO_GROUP = Object.entries(SELLER_BPE_TYPES).reduce((acc,[group,data])=>{
  Object.entries(data.codes).forEach(([code,label])=>{acc[code]={group,label};});
  return acc;
}, {});

async function getBpeAssets(lat,lon,communeCode){
  if(!pool||!Number.isFinite(lat)||!Number.isFinite(lon)||!/^[0-9]{5}$/.test(String(communeCode||""))) return {rows:[],ready:false,importedAt:null};
  const key=String(communeCode)+"|"+lat.toFixed(4)+"|"+lon.toFixed(4);
  const cached=territoryAssetCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  const status=await db("SELECT COUNT(*)::int AS total, MAX(imported_at) AS imported_at FROM jml_bpe_assets WHERE commune_code=$1",[communeCode]);
  const ready=Number(status.rows[0]?.total||0)>0;
  const importedAt=status.rows[0]?.imported_at||null;
  if(!ready){
    const empty={rows:[],ready:false,importedAt:null};
    territoryAssetCache.set(key,{expiresAt:Date.now()+60*60*1000,data:empty});
    return empty;
  }
  const result=await db(`
    SELECT name,domain,subdomain,type_code,type_label,latitude,longitude,
      ROUND((6371*2*ASIN(SQRT(POWER(SIN(RADIANS(latitude-$1)/2),2)+COS(RADIANS($1))*COS(RADIANS(latitude))*POWER(SIN(RADIANS(longitude-$2)/2),2))))::numeric,2) AS distance_km
    FROM jml_bpe_assets
    WHERE commune_code=$3 AND latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude BETWEEN $1-0.02 AND $1+0.03
      AND longitude BETWEEN $2-0.03 AND $2+0.03
    ORDER BY distance_km LIMIT 1000
  `,[lat,lon,communeCode]);
  const rows=result.rows.map(x=>{
    const code=String(x.type_code||"").trim();
    const mapped=SELLER_BPE_CODE_TO_GROUP[code];
    return {name:x.name||null,domain:x.domain,subdomain:x.subdomain||null,typeCode:code,type:x.type_label||mapped?.label||null,sellerGroup:mapped?.group||null,distanceKm:Number(x.distance_km)};
  }).filter(x=>Number.isFinite(x.distanceKm)&&x.distanceKm<=1.5);
  const data={rows,ready:true,importedAt};
  territoryAssetCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data});
  return data;
}

async function getNearbyMajorRoads(lat,lon){
  const la=Number(lat),lo=Number(lon);
  if(!Number.isFinite(la)||!Number.isFinite(lo)) return {available:false,items:[],source:"OpenStreetMap / Overpass"};
  const key=la.toFixed(5)+","+lo.toFixed(5);
  const cached=majorRoadCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  const q=`[out:json][timeout:10];
(way(around:3000,${la},${lo})[highway~"^(motorway|trunk|primary|secondary)$"];);
out center tags;`;
  try{
    const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
    let payload=null,usedEndpoint=null;
    for(const endpoint of endpoints){
      try{
        const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.9.2"},body:"data="+encodeURIComponent(q),signal:AbortSignal.timeout(10000)});
        if(!response.ok) throw new Error("Overpass HTTP "+response.status);
        payload=await response.json(); usedEndpoint=endpoint; break;
      }catch(_error){}
    }
    if(!payload) throw new Error("Aucune instance Overpass disponible");
    const rank={motorway:1,trunk:2,primary:3,secondary:4},rows=[];
    for(const e of (Array.isArray(payload?.elements)?payload.elements:[])){
      const t=e?.tags||{},p=e?.center||e,x=Number(p?.lon),y=Number(p?.lat);
      const distanceKm=haversineKm({lat:la,lon:lo},{lat:y,lon:x});
      const ref=String(t.ref||t.old_ref||"").trim(),name=String(t.name||"").trim(),roadClass=String(t.highway||"");
      if(distanceKm==null||distanceKm>3||(!ref&&!name)) continue;
      rows.push({name:name||ref,ref:ref||null,roadClass,type:roadClass==="motorway"?"Autoroute":roadClass==="trunk"?"Voie rapide":roadClass==="primary"?"Route principale":"Route départementale / secondaire",distanceKm:Number(distanceKm.toFixed(2))});
    }
    rows.sort((a,b)=>a.distanceKm-b.distanceKm || (rank[a.roadClass]||9)-(rank[b.roadClass]||9));
    const seen=new Set(),items=[];
    for(const row of rows){const sig=(row.ref||"")+"|"+(row.name||"");if(seen.has(sig))continue;seen.add(sig);items.push(row);if(items.length>=5)break;}
    const data={available:true,items,source:"OpenStreetMap / Overpass",radiusKm:3,endpoint:usedEndpoint};
    majorRoadCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data}); return data;
  }catch(error){console.warn("JML grands axes routiers:",error.message);return {available:false,items:[],source:"OpenStreetMap / Overpass",radiusKm:3};}
}

function sellerDistanceLabel(km){
  if(km<0.3) return "moins de 300 m";
  if(km<0.8) return "moins de 800 m";
  return "à moins de 1,5 km";
}

async function getSellerAttractiveness(lat,lon){
  const la=Number(lat),lo=Number(lon);
  if(!Number.isFinite(la)||!Number.isFinite(lo)) return {available:false,categories:{}};
  const q=`[out:json][timeout:10];
(
  nwr(around:5000,${la},${lo})[place~"^(city_centre|town_centre)$"];
  nwr(around:5000,${la},${lo})[historic~"^(monument|memorial|castle|fort|archaeological_site)$"];
  nwr(around:5000,${la},${lo})[tourism~"^(attraction|museum|gallery|viewpoint)$"];
  nwr(around:5000,${la},${lo})[amenity~"^(theatre|arts_centre|cinema|marketplace|townhall)$"];
  nwr(around:5000,${la},${lo})[leisure~"^(park|garden|nature_reserve)$"];
  nwr(around:5000,${la},${lo})[highway=pedestrian];
);
out center tags;`;
  try{
    const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
    let payload=null,usedEndpoint=null;
    for(const endpoint of endpoints){
      try{
        const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.9.2 (attractiveness)"},body:"data="+encodeURIComponent(q),signal:AbortSignal.timeout(10000)});
        if(!response.ok) continue;
        payload=await response.json(); usedEndpoint=endpoint; break;
      }catch(_){}
    }
    if(!payload) throw new Error("Aucune instance Overpass disponible");
    const categories={center:{label:"Centre-ville",items:[]},heritage:{label:"Patrimoine & monuments",items:[]},culture:{label:"Culture & lieux emblématiques",items:[]},leisure:{label:"Parcs & espaces de respiration",items:[]},publicLife:{label:"Vie locale",items:[]}};
    const seen=new Set();
    const distance=(e)=>{
      const p=e?.center||e,x=Number(p?.lon??e?.lon),y=Number(p?.lat??e?.lat);
      const d=haversineKm({lat:la,lon:lo},{lat:y,lon:x});
      return d==null?999:d;
    };
    const add=(cat,e,type)=>{
      const t=e?.tags||{},d=distance(e);
      if(d>5)return;
      const name=String(t.name||"").trim();
      if(!name)return;
      const sig=cat+"|"+name.toLowerCase();
      if(seen.has(sig))return;
      seen.add(sig);
      categories[cat].items.push({name,type,distanceKm:Number(d.toFixed(2))});
    };
    for(const e of (Array.isArray(payload?.elements)?payload.elements:[])){
      const t=e?.tags||{};
      if(/^(city_centre|town_centre)$/.test(String(t.place||""))) add("center",e,"Centre-ville");
      else if(/^(monument|memorial|castle|fort|archaeological_site)$/.test(String(t.historic||""))) add("heritage",e,
        t.historic==="castle"?"Château":t.historic==="fort"?"Fort":t.historic==="memorial"?"Mémorial":"Monument");
      else if(/^(attraction|museum|gallery|viewpoint)$/.test(String(t.tourism||""))) add("culture",e,
        t.tourism==="museum"?"Musée":t.tourism==="gallery"?"Galerie":t.tourism==="viewpoint"?"Point de vue":"Lieu emblématique");
      else if(/^(theatre|arts_centre|cinema)$/.test(String(t.amenity||""))) add("culture",e,
        t.amenity==="theatre"?"Théâtre":t.amenity==="cinema"?"Cinéma":"Centre culturel");
      else if(t.leisure==="park"||t.leisure==="garden"||t.leisure==="nature_reserve") add("leisure",e,"Parc / espace vert");
      else if(t.amenity==="marketplace"||t.amenity==="townhall"||t.highway==="pedestrian") add("publicLife",e,
        t.amenity==="marketplace"?"Marché":t.amenity==="townhall"?"Mairie":"Zone piétonne");
    }
    Object.values(categories).forEach(c=>c.items.sort((a,b)=>a.distanceKm-b.distanceKm).splice(6));
    return {available:true,source:"OpenStreetMap / Overpass",endpoint:usedEndpoint,categories};
  }catch(error){
    console.warn("JML attractivité locale:",error.message);
    return {available:false,source:"OpenStreetMap / Overpass",categories:{}};
  }
}

async function getOfficialTerritoryAssets(lat,lon,communeCode){
  const [education,bpe,roads,attractiveness]=await Promise.allSettled([getEducationAssets(lat,lon,communeCode),getBpeAssets(lat,lon,communeCode),getNearbyMajorRoads(lat,lon),getSellerAttractiveness(lat,lon)]);
  const schools=education.status==="fulfilled"?education.value:[];
  const bpeData=bpe.status==="fulfilled"?bpe.value:{rows:[],ready:false,importedAt:null};
  const bpeRows=bpeData.rows||[];
  const bpeReady=Boolean(bpeData.ready);
  const roadData=roads.status==="fulfilled"?roads.value:{available:false,items:[]};
  const attractData=attractiveness.status==="fulfilled"?attractiveness.value:{available:false,categories:{}};
  const bpeGroup=(group)=>bpeRows.filter(x=>x.sellerGroup===group && x.distanceKm<=0.8);
  const nearest=(rows,limit=5)=>rows.slice().sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,limit);
  const family=nearest(schools.map(x=>({...x,group:"family",distanceLabel:sellerDistanceLabel(x.distanceKm)})).concat(
    bpeGroup("family").map(x=>({...x,group:"family",distanceLabel:sellerDistanceLabel(x.distanceKm)}))
  ),6);
  const categories={
    daily:{label:"Commerces du quotidien",count:bpeGroup("daily").length,available:bpeReady,items:nearest(bpeGroup("daily").map(x=>({...x,group:"daily",distanceLabel:sellerDistanceLabel(x.distanceKm)})),6),source:"INSEE BPE 2025"},
    family:{label:"Écoles & famille",count:family.length,available:education.status==="fulfilled"||bpeReady,items:family,source:"Éducation nationale + INSEE BPE 2025"},
    health:{label:"Santé de proximité",count:bpeGroup("health").length,available:bpeReady,items:nearest(bpeGroup("health").map(x=>({...x,group:"health",distanceLabel:sellerDistanceLabel(x.distanceKm)})),6),source:"INSEE BPE 2025"},
    mobility:{label:"Mobilité",count:bpeRows.filter(x=>["E107","E108","E109"].includes(x.typeCode)&&x.distanceKm<=0.8).length,available:bpeReady,items:nearest(bpeRows.filter(x=>["E107","E108","E109"].includes(x.typeCode)&&x.distanceKm<=1.5).map(x=>({...x,group:"mobility",name:x.name?("Gare de "+x.name):"Gare de voyageurs",type:x.type||"Gare de voyageurs",distanceLabel:sellerDistanceLabel(x.distanceKm)})),5),source:"INSEE BPE 2025"},
    leisure:{label:"Loisirs & vie locale",count:bpeGroup("leisure").length,available:bpeReady,items:nearest(bpeGroup("leisure").map(x=>({...x,group:"leisure",distanceLabel:sellerDistanceLabel(x.distanceKm)})),5),source:"INSEE BPE 2025"},
    roads:{label:"Grands axes routiers",count:roadData.items?.length||0,available:roadData.available===true,items:roadData.items||[],source:"OpenStreetMap / Overpass"},
    center:attractData.categories?.center||{label:"Centre-ville",items:[],available:false},
    heritage:attractData.categories?.heritage||{label:"Patrimoine & monuments",items:[],available:false},
    culture:attractData.categories?.culture||{label:"Culture & lieux emblématiques",items:[],available:false},
    publicLife:attractData.categories?.publicLife||{label:"Vie locale",items:[],available:false},
    attractiveness:attractData.categories?.leisure||{label:"Parcs & espaces de respiration",items:[],available:false}
  };
  return {
    available:education.status==="fulfilled"||bpeReady,
    provider:"Données publiques officielles",
    source:"Éducation nationale + INSEE BPE 2025",
    sourceUrl:"https://www.insee.fr/fr/statistiques/8217525",
    radiusKm:1.5,sellerRadiusKm:0.8,importedAt:bpeData.importedAt,categories,roadSource:roadData.source||"OpenStreetMap / Overpass",roadRadiusKm:3,attractivenessSource:attractData.source||"OpenStreetMap / Overpass",
    diagnostics:{education:education.status==="fulfilled"?"OK":String(education.reason?.message||"indisponible"),bpe:bpe.status==="fulfilled"?(bpeReady?"OK":"BPE Ardennes non importé"):String(bpe.reason?.message||"indisponible"),roads:roads.status==="fulfilled"?(roadData.available?"OK":"indisponible"):String(roads.reason?.message||"indisponible"),attractiveness:attractiveness.status==="fulfilled"?(attractData.available?"OK":"indisponible"):String(attractiveness.reason?.message||"indisponible")}
  };
}


const communeExternalDvfCache = new Map();

function normalizeExternalDvfRow(row, fallbackCity=""){
  const value=Number(row?.valeur_fonciere);
  const built=Number(row?.surface_reelle_bati);
  const land=Number(row?.surface_terrain);
  const typeLocal=String(row?.type_local||"").trim();
  let type=null;
  if(/maison/i.test(typeLocal)) type="Maison";
  else if(/appartement/i.test(typeLocal)) type="Appartement";
  else if(!typeLocal && Number.isFinite(land)&&land>0 && (!Number.isFinite(built)||built<=0)) type="Terrain";
  if(!type||!Number.isFinite(value)||value<=0) return null;
  const surface=type==="Terrain"?0:(Number.isFinite(built)&&built>0?built:0);
  const comparableSurface=type==="Terrain"?land:surface;
  if(!Number.isFinite(comparableSurface)||comparableSurface<=0) return null;
  const pricePerM2=value/comparableSurface;
  if(!Number.isFinite(pricePerM2)||pricePerM2<=0||pricePerM2>100000) return null;
  const date=String(row?.date_mutation||"").slice(0,10);
  const address=[row?.adresse_numero,row?.adresse_suffixe,row?.adresse_nom_voie].filter(Boolean).join(" ").trim();
  return {
    id:String(row?.id_mutation||[date,address,value,comparableSurface].join("|")),
    date,
    type,
    price:value,
    surface,
    rooms:Number(row?.nombre_pieces_principales)||null,
    land:Number.isFinite(land)&&land>0?land:null,
    lat:Number(row?.latitude)||null,
    lon:Number(row?.longitude)||null,
    address,
    street:String(row?.adresse_nom_voie||"").trim(),
    postal:String(row?.code_postal||"").trim(),
    code:String(row?.code_commune||"").trim(),
    city:String(row?.nom_commune||fallbackCity).trim(),
    pricePerM2,
    source:"DVF public / API Cquest"
  };
}

async function getExternalDvfByCommune(communeCode, city=""){
  const code=String(communeCode||"").trim();
  if(!/^\d{5}$/.test(code)) return [];
  const key=code;
  const cached=communeExternalDvfCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.rows;
  try{
    const url="https://api.cquest.org/dvf?code_commune="+encodeURIComponent(code)+"&nature_mutation=Vente";
    const response=await fetch(url,{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/3.5.0"},
      signal:AbortSignal.timeout(12000)
    });
    if(!response.ok) throw new Error("DVF externe HTTP "+response.status);
    const payload=await response.json();
    const raw=Array.isArray(payload?.resultats)?payload.resultats:(Array.isArray(payload?.features)?payload.features.map(x=>x?.properties||{}):[]);
    const rows=raw.map(x=>normalizeExternalDvfRow(x,city)).filter(Boolean);
    communeExternalDvfCache.set(key,{expiresAt:Date.now()+6*60*60*1000,rows});
    return rows;
  }catch(error){
    console.warn("JML DVF externe secours:",error.message);
    return [];
  }
}

const communeMarketCache = new Map();
const IMMO_DATA_API_BASE_URL = String(process.env.IMMO_DATA_API_BASE_URL || "https://api.immo-data.fr").replace(/\/+$/,"");

async function immoDataRequest(endpoint, params = {}) {
  const apiKey = String(process.env.IMMO_DATA_API_KEY || "").trim();
  if (!apiKey) throw new Error("IMMO_DATA_API_KEY non configurée sur Render");
  const url = new URL(IMMO_DATA_API_BASE_URL + endpoint);
  Object.entries(params).forEach(([key,value]) => {
    if (value !== undefined && value !== null && String(value) !== "") url.searchParams.set(key, String(value));
  });
  const response = await fetch(url, {
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Accept": "application/json",
      "User-Agent": "JML-Projet-Vendeur/3.3.0"
    },
    signal: AbortSignal.timeout(10000)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}
  if (!response.ok) {
    const detail = payload?.message || payload?.error || ("HTTP " + response.status);
    throw new Error("Immo Data " + response.status + " — " + detail);
  }
  return payload;
}

// Test léger de la clé Render : le géocodage coûte seulement 0,001 €
// et permet de vérifier simultanément l'URL, l'Authorization et la réponse API.
app.get("/api/immo-data/test", async (req,res) => {
  const city = clean(req.query.city || "Charleville-Mézières",100);
  if (!process.env.IMMO_DATA_API_KEY) {
    return res.status(503).json({ok:false,configured:false,error:"IMMO_DATA_API_KEY absente de l'environnement Render."});
  }
  try {
    const data = await immoDataRequest("/v1/geocode", {q:city, geoLevel:"city", limit:1});
    return res.json({
      ok:true,
      configured:true,
      provider:"Immo Data",
      endpoint:"/v1/geocode",
      query:city,
      resultCount:Array.isArray(data) ? data.length : Array.isArray(data?.data) ? data.data.length : null,
      message:"Connexion Immo Data opérationnelle."
    });
  } catch (error) {
    console.error("JML Immo Data test:", error.message);
    return res.status(502).json({ok:false,configured:true,provider:"Immo Data",error:error.message});
  }
});



/* ---------- Territoire : sécurité, risques et environnement ---------- */
const ssmsiSecurityCache = new Map();
let ssmsiSecurityLoadPromise = null;
const SSMSI_SECURITY_URL = "https://static.data.gouv.fr/resources/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales/20260709-115942/donnee-data.gouv-2025-geographie2026-produit-le2026-06-25.csv.gz";
const SSMSI_SECURITY_SOURCE = "SSMSI / Ministère de l'Intérieur — données 2025, délinquance enregistrée au lieu de commission";

function parseCsvSemicolonLine(line){
  const out=[]; let value=""; let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){ value+='"'; i++; }
      else quoted=!quoted;
    }else if(ch===";" && !quoted){ out.push(value); value=""; }
    else value+=ch;
  }
  out.push(value);
  return out.map(v=>v.trim());
}
function parseNumericLoose(value){
  const v=String(value??"").trim();
  if(!v || v.toUpperCase()==="NA") return null;
  const n=Number(v.replace(/\s/g,"").replace(",","."));
  return Number.isFinite(n)?n:null;
}
function normalizeSecurityIndicator(name){
  return String(name||"").trim();
}
function securityUnitLabel(indicator){
  return /Cambriolages de logement/i.test(indicator) ? "pour 1 000 logements" : "pour 1 000 habitants";
}
function securityShortLabel(indicator){
  const labels={
    "Cambriolages de logement":"Cambriolages de logement",
    "Vols de véhicule":"Vols de véhicules",
    "Vols dans les véhicules":"Vols dans les véhicules",
    "Destructions et dégradations volontaires":"Dégradations volontaires",
    "Vols sans violence contre des personnes":"Vols sans violence",
    "Violences physiques intrafamiliales":"Violences intrafamiliales",
    "Violences physiques hors cadre familial":"Violences hors cadre familial",
    "Violences sexuelles":"Violences sexuelles",
    "Escroqueries et fraudes aux moyens de paiement":"Escroqueries / fraudes",
    "Usage de stupéfiants":"Usage de stupéfiants",
    "Trafic de stupéfiants":"Trafic de stupéfiants"
  };
  return labels[indicator] || indicator;
}
async function loadSsmsiSecurityDataset(){
  if(ssmsiSecurityLoadPromise) return ssmsiSecurityLoadPromise;
  ssmsiSecurityLoadPromise=(async()=>{
    const response=await fetch(SSMSI_SECURITY_URL,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(45000)});
    if(!response.ok) throw new Error("SSMSI HTTP "+response.status);
    if(!response.body) throw new Error("SSMSI flux indisponible");
    const gunzip=zlib.createGunzip();
    const input=Readable.fromWeb(response.body).pipe(gunzip);
    const rl=readline.createInterface({input,crlfDelay:Infinity});
    let header=null, idx={};
    let loaded=0;
    for await(const line of rl){
      if(!line) continue;
      if(!header){
        header=parseCsvSemicolonLine(line).map(v=>v.replace(/^"|"$/g,""));
        header.forEach((name,i)=>{idx[String(name||"").trim().toLowerCase()]=i;});
        continue;
      }
      const row=parseCsvSemicolonLine(line);
      const year=String(row[idx.annee]||row[idx.annee_donnees]||"").trim();
      if(year!=="2025") continue;
      const code=String(row[idx.codgeo_2026]||row[idx.codgeo_2025]||row[idx.codgeo]||"").trim();
      const indicator=normalizeSecurityIndicator(row[idx.indicateur]);
      if(!code || !indicator) continue;
      if(!ssmsiSecurityCache.has(code)) ssmsiSecurityCache.set(code,{year:2025,indicators:{},population:parseNumericLoose(row[idx.insee_pop]),logements:parseNumericLoose(row[idx.insee_log])});
      const entry=ssmsiSecurityCache.get(code);
      entry.indicators[indicator]={
        label:securityShortLabel(indicator),
        indicator,
        unit:securityUnitLabel(indicator),
        count:parseNumericLoose(row[idx.nombre]),
        rate:parseNumericLoose(row[idx.taux_pour_mille]),
        status:String(row[idx.est_diffuse]||"").trim(),
        available:String(row[idx.est_diffuse]||"").trim().toLowerCase()==="diff"
      };
      loaded++;
    }
    return {communes:ssmsiSecurityCache.size,rows:loaded};
  })().catch(error=>{
    ssmsiSecurityLoadPromise=null;
    throw error;
  });
  return ssmsiSecurityLoadPromise;
}
async function getSecurityData(code){
  const cleanCode=String(code||"").trim();
  if(!/^\d{5}$/.test(cleanCode)) return {available:false,year:2025,source:SSMSI_SECURITY_SOURCE,message:"Code commune non disponible."};
  const sourceUrl="https://www.mon-quartier-info.com/securite/"+cleanCode;
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+cleanCode,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const labels=["Destructions et dégradations volontaires","Vols sans violence contre des personnes","Cambriolages de logement","Vols de véhicule","Vols dans les véhicules","Vols d'accessoires sur véhicules","Violences physiques intrafamiliales","Violences physiques hors cadre familial","Violences sexuelles","Escroqueries et fraudes aux moyens de paiement"];
      const indicators=[];
      for(const label of labels){
        const safe=label.replace(/[.*+?^$()|[\]\\]/g,"\\$&");
        const re=new RegExp(safe+"\\s+([0-9\\s]+)\\s+(?:faits|victimes|véhicules)\\s+([0-9]+(?:[.,][0-9]+)?)","i");
        const m=text.match(re);
        if(m) indicators.push({label,indicator:label,count:Number(m[1].replace(/\\s/g,"")),rate:Number(m[2].replace(",",".")),unit:label==="Cambriolages de logement"?"‰ logements":"‰ habitants",available:true});
      }
      if(indicators.length) return {available:true,year:2025,indicators,source:"SSMSI / Ministère de l’Intérieur — via source publique de restitution",sourceUrl,note:"Les chiffres proviennent du SSMSI 2025. Aucun score JML n'est calculé."};
    }
  }catch(error){console.warn("JML sécurité source publique:",error.message);}
  try{
    await loadSsmsiSecurityDataset();
    const record=ssmsiSecurityCache.get(cleanCode);
    if(record){
      const preferred=["Cambriolages de logement","Vols de véhicule","Vols dans les véhicules","Destructions et dégradations volontaires","Vols sans violence contre des personnes","Violences physiques intrafamiliales","Violences physiques hors cadre familial","Violences sexuelles","Escroqueries et fraudes aux moyens de paiement"];
      const indicators=preferred.map(k=>record.indicators[k]).filter(Boolean);
      return {available:true,year:record.year,population:record.population,logements:record.logements,indicators,source:SSMSI_SECURITY_SOURCE,sourceUrl:"https://www.data.gouv.fr/datasets/bases-statistiques-communale-departementale-et-regionale-de-la-delinquance-enregistree-par-la-police-et-la-gendarmerie-nationales",note:"Faits enregistrés par la police et la gendarmerie. Une donnée non diffusée ne signifie pas zéro."};
    }
  }catch(error){console.warn("JML SSMSI dataset:",error.message);}
  return {available:false,year:2025,source:SSMSI_SECURITY_SOURCE,message:"Données de sécurité temporairement indisponibles."};
}

async function getGeoRisks(code){
  const cleanCode=String(code||"").trim();
  if(!/^\d{5}$/.test(cleanCode)) return {available:false,message:"Code INSEE non disponible."};
  const reportUrl="https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2/"+cleanCode+"/commune/00000";
  try{
    const response=await fetch("https://www.georisques.gouv.fr/api/v1/gaspar/risques?code_insee="+encodeURIComponent(cleanCode)+"&rayon=1000&page=1&page_size=100",{headers:{"User-Agent":"JML-Projet-Vendeur/3.0","Accept":"application/json"},signal:AbortSignal.timeout(6000)});
    if(response.ok){
      const payload=await response.json();
      const rawRows=Array.isArray(payload)?payload:(Array.isArray(payload.data)?payload.data:(Array.isArray(payload.resultats)?payload.resultats:[]));
      const rows=[];
      for(const row of rawRows){
        if(Array.isArray(row?.risques_detail)) rows.push(...row.risques_detail);
        else rows.push(row);
      }
      const labels=[...new Set(rows.map(r=>String(r.libelle_risque_long||r.libelle_risque_jo||r.libelle||r.nom||r.libelle_risque||r.risque||"").trim()).filter(Boolean))].slice(0,12);
      if(labels.length) return {available:true,source:"Géorisques / BRGM",sourceUrl:"https://www.georisques.gouv.fr/",risks:labels,count:labels.length,note:"Information à l'échelle communale. Vérification à l'adresse/parcelle recommandée."};
    }
  }catch(error){console.warn("JML Géorisques API:",error.message);}
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+cleanCode,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const risks=[];
      const patterns=[["Inondation","inondation"],["Mouvement de terrain","mouvement de terrain"],["Séisme","séisme"],["Transport de marchandises dangereuses","transport de marchandises dangereuses"],["Sécheresse","sécheresse"]];
      for(const [label,pattern] of patterns) if(new RegExp(pattern,"i").test(text)) risks.push(label);
      const m=text.match(/([0-9]+) arrêtés? de catastrophe naturelle/i);
      if(risks.length||m) return {available:true,source:"Géorisques / BRGM — restitution publique",sourceUrl:"https://www.mon-quartier-info.com/commune/"+cleanCode,risks,count:risks.length,catNatCount:m?Number(m[1]):null,note:"Repère communal issu de données Géorisques. Il ne remplace pas un état des risques à l'adresse ou à la parcelle."};
    }
  }catch(error){console.warn("JML risques secours:",error.message);}
  return {available:false,message:"Données Géorisques temporairement indisponibles.",reportUrl};
}

const localEnvironmentCache=new Map();
async function getLocalEnvironment(commune){
  const code=String(commune?.code||"").trim();
  if(!/^\d{5}$/.test(code)) return {available:false,message:"Code commune indisponible."};
  const key=code;
  const cached=localEnvironmentCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  try{
    const response=await fetch("https://www.mon-quartier-info.com/commune/"+code,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
    if(response.ok){
      const text=stripHtml(await response.text());
      const pick=label=>{const m=text.match(new RegExp(label+"\\s*\\((\\d+)\\)","i"));return m?Number(m[1]):null;};
      const schools=pick("École"),health=pick("Médecin généraliste"),pharmacies=pick("Pharmacie"),shops=pick("Alimentation générale"),postOffices=pick("Bureau ou relais de poste"),stations=pick("Gare de voyageurs");
      const sm=text.match(/([0-9\s]+) équipements et services recensés sur la commune/i);
      const data={available:true,source:"INSEE BPE / Mon Quartier Info",sourceUrl:"https://www.mon-quartier-info.com/commune/"+code,counters:{schools:schools??0,health:health??0,pharmacies:pharmacies??0,shops:shops??0,stations:stations??0,busStops:null,postOffices:postOffices??0,totalServices:sm?Number(sm[1].replace(/\s/g,"")):null},names:{schools:[],health:[],pharmacies:[],shops:[],stations:[]},radiusKm:null,note:"Comptage communal issu principalement de la Base permanente des équipements (INSEE)."};
      localEnvironmentCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data});
      return data;
    }
  }catch(error){console.warn("JML services source publique:",error.message);}
  // Secours indépendant : OpenStreetMap / Overpass autour du centre communal.
  // Cela évite que la panne de Mon Quartier Info rende tout le bloc vide.
  try{
    const coords=commune?.centre?.coordinates;
    if(Array.isArray(coords)&&coords.length>=2){
      const osm=await getNearbyAssets(Number(coords[1]),Number(coords[0]));
      if(osm?.available){
        const cats=osm.categories||{};
        const count=k=>Number(cats[k]?.count||0);
        const data={
          available:true,
          source:"OpenStreetMap / Overpass — secours local",
          sourceUrl:"https://www.openstreetmap.org/",
          counters:{
            schools:count("schools"),
            health:count("health"),
            pharmacies:(cats.health?.items||[]).filter(x=>/pharm/i.test(String(x.name||""))).length,
            shops:count("commerces"),
            stations:count("transport"),
            busStops:null,
            postOffices:(cats.services?.items||[]).filter(x=>/poste/i.test(String(x.name||""))).length,
            totalServices:Object.values(cats).reduce((sum,x)=>sum+Number(x?.count||0),0)
          },
          names:{schools:cats.schools?.items||[],health:cats.health?.items||[],pharmacies:[],shops:cats.commerces?.items||[],stations:cats.transport?.items||[]},
          radiusKm:1.5,
          note:"Repère de proximité calculé à partir des équipements OpenStreetMap dans un rayon de 1,5 km autour du centre communal. Il ne remplace pas un inventaire INSEE BPE exhaustif."
        };
        localEnvironmentCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data});
        return data;
      }
    }
  }catch(error){console.warn("JML services OSM secours:",error.message);}
  return {available:false,message:"Les services locaux sont temporairement indisponibles."};
}

const normalizeSearchCity = value => String(value || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLowerCase().replace(/[^a-z0-9 -]/g,"").replace(/\s+/g," ").trim();

function decodeBasicEntities(value){
  return String(value || "")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&#39;|&apos;/gi,"'")
    .replace(/&quot;/gi,'"').replace(/&eacute;/gi,"é").replace(/&egrave;/gi,"è")
    .replace(/&ecirc;/gi,"ê").replace(/&agrave;/gi,"à").replace(/&acirc;/gi,"â")
    .replace(/&ocirc;/gi,"ô").replace(/&ugrave;/gi,"ù").replace(/&ucirc;/gi,"û")
    .replace(/&ccedil;/gi,"ç");
}

async function getCommuneMarketData(city,code){
  const cleanCity=clean(city,100), communeCode=String(code||"").trim();
  const key="pg2|"+normalizeSearchCity(cleanCity)+"|"+communeCode;
  const cached=communeMarketCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return {...cached.data,cache:true};

  const empty={
    city:cleanCity,found:false,
    source:"DVF local JML / PostgreSQL",
    sourceUrl:"https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/",
    message:"Aucune transaction DVF disponible pour cette commune.",
    recentSales:[],recentSalesSource:"DVF",
    nearby:[],history:[],transactions:null,
    communalPrice:null,housePrice:null,apartmentPrice:null,terrainPrice:null
  };

  // 1. PostgreSQL reste la source principale lorsque les données DVF ont été importées.
  if(pool&&/^\d{5}$/.test(communeCode)){
    try{
      const summary=await db(`SELECT COUNT(*)::int AS transactions,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) AS communal_price,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) FILTER (WHERE property_type='Maison') AS house_price,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) FILTER (WHERE property_type='Appartement') AS apartment_price,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (price / NULLIF(land_surface,0))) FILTER (WHERE property_type='Terrain' AND land_surface>0) AS terrain_price
        FROM jml_dvf_sales
        WHERE commune_code=$1 AND sale_date>=CURRENT_DATE-INTERVAL '48 months'`,[communeCode]);
      const s=summary.rows[0]||{};
      if(Number(s.transactions||0)>0){
        const recent=await db(`SELECT mutation_id AS id,TO_CHAR(sale_date,'YYYY-MM-DD') AS date,property_type AS type,
          price::float8 AS price,surface::float8 AS surface,rooms::float8 AS rooms,land_surface::float8 AS land,
          latitude AS lat,longitude AS lon,address,street,postal_code AS postal,commune_code AS code,
          commune_name AS city,price_per_m2::float8 AS "pricePerM2",source
          FROM jml_dvf_sales WHERE commune_code=$1 AND sale_date>=CURRENT_DATE-INTERVAL '24 months'
          ORDER BY sale_date DESC LIMIT 12`,[communeCode]);
        const history=await db(`SELECT EXTRACT(YEAR FROM sale_date)::int AS year,COUNT(*)::int AS transactions,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) AS value
          FROM jml_dvf_sales WHERE commune_code=$1 GROUP BY EXTRACT(YEAR FROM sale_date) ORDER BY year`,[communeCode]);
        const data={
          city:cleanCity,found:true,source:"DVF local JML / PostgreSQL",
          sourceUrl:"https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/",
          message:"Repère communal calculé à partir des transactions DVF importées dans PostgreSQL.",
          recentSales:recent.rows,recentSalesSource:"DVF local JML / PostgreSQL",nearby:[],
          history:history.rows.map(x=>({year:x.year,value:x.value!=null?Math.round(Number(x.value)):null,transactions:x.transactions})),
          transactions:Number(s.transactions)||null,
          communalPrice:s.communal_price!=null?Math.round(Number(s.communal_price)):null,
          housePrice:s.house_price!=null?Math.round(Number(s.house_price)):null,
          apartmentPrice:s.apartment_price!=null?Math.round(Number(s.apartment_price)):null,
          terrainPrice:s.terrain_price!=null?Math.round(Number(s.terrain_price)):null,
          period:"DVF importé / 24 derniers mois"
        };
        communeMarketCache.set(key,{expiresAt:Date.now()+6*60*60*1000,data});
        return {...data,cache:false};
      }
    }catch(error){
      console.warn("JML PostgreSQL DVF market:",error.message);
    }
  }

  // 2. Secours automatique : DVF public géolocalisé. Cela évite d'afficher
  // "Aucune donnée" lorsque PostgreSQL n'a pas encore reçu l'import DVF.
  const external=await getExternalDvfByCommune(communeCode,cleanCity);
  if(external.length){
    const values=external.map(x=>x.pricePerM2).filter(Number.isFinite).sort((a,b)=>a-b);
    const median=values.length?(values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2):null;
    const medianOf=type=>{const v=external.filter(x=>x.type===type).map(x=>x.pricePerM2).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?(v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2):null;};
    const terrain=external.filter(x=>x.type==="Terrain").map(x=>x.pricePerM2).filter(Number.isFinite).sort((a,b)=>a-b);
    const terrainMedian=terrain.length?(terrain.length%2?terrain[(terrain.length-1)/2]:(terrain[terrain.length/2-1]+terrain[terrain.length/2])/2):null;
    const years={};
    external.forEach(x=>{const y=String(x.date||"").slice(0,4);if(!years[y])years[y]=[];years[y].push(x.pricePerM2);});
    const history=Object.entries(years).sort((a,b)=>a[0].localeCompare(b[0])).map(([year,v])=>({
      year:Number(year),transactions:v.length,value:Math.round(v.slice().sort((a,b)=>a-b)[Math.floor((v.length-1)/2)])
    }));
    const data={
      city:cleanCity,found:true,source:"DVF public / API Cquest",
      sourceUrl:"https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/",
      message:"Transactions DVF publiques chargées pour cette commune. Les données détaillées servent de repère de marché et de comparables.",
      recentSales:external.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,50),
      recentSalesSource:"DVF public / API Cquest",nearby:[],history,
      transactions:external.length,
      communalPrice:median!=null?Math.round(median):null,
      housePrice:medianOf("Maison")!=null?Math.round(medianOf("Maison")):null,
      apartmentPrice:medianOf("Appartement")!=null?Math.round(medianOf("Appartement")):null,
      terrainPrice:terrainMedian!=null?Math.round(terrainMedian):null,
      period:"DVF public disponible / transactions de la commune"
    };
    communeMarketCache.set(key,{expiresAt:Date.now()+6*60*60*1000,data});
    return {...data,cache:false};
  }

  const result={...empty,source:"DVF public + PostgreSQL",message:"Les sources DVF n'ont renvoyé aucune transaction exploitable pour cette commune."};
  communeMarketCache.set(key,{expiresAt:Date.now()+30*60*1000,data:result});
  return {...result,cache:false};
}

async function getLocalDvfComparables(origin,maxKm=3,communeCode="",propertyType=""){
  if(!pool||!origin)return [];
  const lat=Number(origin.lat),lon=Number(origin.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon))return [];
  const dLat=maxKm/111,dLon=maxKm/(111*Math.max(0.2,Math.cos(lat*Math.PI/180)));
  // On récupère tout le stock DVF pertinent de la commune sur 48 mois,
  // en plus de la fenêtre géographique. La distance exacte est ensuite
  // recalculée dans le moteur : cela évite de perdre des ventes valides
  // à cause d'un géocodage ou d'une limite SQL trop restrictive.
  // Important : ne plus charger toute la commune. La recherche des comparables
  // doit rester géographique et limitée au type du bien ; l'ancien OR commune_code
  // pouvait ramener plusieurs milliers de lignes et faire expirer la requête.
  const wantedType=classifyDvfType(propertyType,"");
  const params=[lat-dLat,lat+dLat,lon-dLon,lon+dLon];
  let typeClause="";
  if(wantedType){
    params.push(wantedType);
    typeClause=" AND property_type=$5";
  }
  const result=await db(`SELECT mutation_id AS id,TO_CHAR(sale_date,'YYYY-MM-DD') AS date,property_type AS type,price::float8 AS price,surface::float8 AS surface,rooms::float8 AS rooms,land_surface::float8 AS land,latitude AS lat,longitude AS lon,address,street,postal_code AS postal,commune_code AS code,commune_name AS city,price_per_m2::float8 AS "pricePerM2",source
    FROM jml_dvf_sales
    WHERE sale_date>=CURRENT_DATE-INTERVAL '48 months'
      AND latitude BETWEEN $1 AND $2
      AND longitude BETWEEN $3 AND $4
      ${typeClause}
    ORDER BY sale_date DESC
    LIMIT 3000`,params);
  return result.rows;
}

function buildSellerReference(market,property){
  const type=String(property?.propertyType||"").toLowerCase();
  const isApartment=/appartement|studio|duplex|loft/i.test(type);
  const isHouse=/maison/i.test(type);
  const typeLabel=isApartment?"Appartement":isHouse?"Maison":"Tous biens";
  const base= isApartment?Number(market?.apartmentPrice):isHouse?Number(market?.housePrice):Number(market?.communalPrice||market?.price);
  const surface=Number(property?.surface);
  const hasBase=Number.isFinite(base)&&base>0;
  const hasSurface=Number.isFinite(surface)&&surface>0;
  const raw=hasBase&&hasSurface?Math.round(base*surface):null;
  const low=raw!==null?Math.round(raw*0.85):null;
  const high=raw!==null?Math.round(raw*1.15):null;
  return {
    available:hasBase,
    type:typeLabel,
    basePriceM2:hasBase?base:null,
    surface:hasSurface?surface:null,
    referenceValue:raw,
    range:{low,high,marginPct:15},
    transactions:Number.isFinite(Number(market?.transactions))?Number(market.transactions):null,
    history:Array.isArray(market?.history)?market.history:[],
    comparables:market?.comparables||{sales:[],sameStreet:[],median:null,matchCount:0},
    explanation:hasBase&&hasSurface
      ? "Repère mathématique construit à partir du prix médian du type de bien et de la surface renseignée. La fourchette de ±15 % sert à matérialiser l’écart possible autour du repère ; elle ne constitue pas une estimation certifiée."
      : "Le repère sera calculé dès que le type de bien et la surface seront suffisamment renseignés."
  };
}

async function getNearbyCommunes(commune){
  const dep=String(commune?.departement?.code||"08");
  try{
    const url="https://geo.api.gouv.fr/departements/"+encodeURIComponent(dep)+"/communes?fields=nom,code,population,centre&format=json";
    const response=await fetch(url,{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(6000)});
    if(!response.ok) throw new Error("Geo API HTTP "+response.status);
    const rows=await response.json(),origin=commune?.centre?.coordinates;
    if(!Array.isArray(origin)||origin.length<2) return [];
    const o={lon:Number(origin[0]),lat:Number(origin[1])};
    return rows.map(x=>{
      const p=x?.centre?.coordinates;if(!Array.isArray(p)||p.length<2)return null;
      const d=haversineKm(o,{lon:Number(p[0]),lat:Number(p[1])});
      return d!=null?{name:x.nom,code:x.code,population:x.population,distanceKm:Number(d.toFixed(1))}:null;
    }).filter(Boolean).filter(x=>x.code!==commune.code&&x.distanceKm<=20).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,6);
  }catch(error){
    console.warn("JML communes proches Geo API:",error.message);
    try{
      const response=await fetch("https://www.mon-quartier-info.com/commune/"+String(commune?.code||""),{headers:{"User-Agent":"JML-Projet-Vendeur/3.0"},signal:AbortSignal.timeout(7000)});
      if(response.ok){
        const html=await response.text(),out=[],seen=new Set();
        const re=/<a[^>]+href=["\']\/commune\/(\d{5})["\'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while((m=re.exec(html))&&out.length<6){
          const code=m[1],name=stripHtml(m[2]);
          if(code!==String(commune?.code||"")&&!seen.has(code)&&name){seen.add(code);out.push({name,code,population:null,distanceKm:null});}
        }
        return out;
      }
    }catch(fallbackError){console.warn("JML communes proches secours:",fallbackError.message);}
    return [];
  }
}

async function resolveTerritoryCommune(city,address){
  const requestedCity=String(city||"").trim();
  const requestedAddress=String(address||"").trim();
  if(!requestedCity) return null;

  const postalMatch=requestedAddress.match(/\b(\d{5})\b/) || requestedCity.match(/\b(\d{5})\b/);
  const postal=postalMatch ? postalMatch[1] : "";
  const cityName=requestedCity
    .replace(/\b\d{5}\b/g," ")
    .replace(/\s+/g," ")
    .trim();

  const normalizeName=value=>String(value||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/['’\-]/g," ")
    .replace(/\s+/g," ").trim()
    .replace(/^(le|la|les|l|d|de|du|des)\s+/,"");

  const wanted=normalizeName(cityName);

  const chooseCandidate=(rows)=>{
    const list=Array.isArray(rows)?rows.filter(Boolean):[];
    if(!list.length) return null;

    const exact=list.find(row=>normalizeName(row.nom)===wanted);
    const starts=list.find(row=>{
      const n=normalizeName(row.nom);
      return n===wanted || n.startsWith(wanted+" ") || wanted.startsWith(n+" ");
    });
    const selected=exact||starts||list[0];
    if(!selected || !/^\d{5}$/.test(String(selected.code||""))) return null;

    const centre=selected.centre&&Array.isArray(selected.centre.coordinates)
      ?selected.centre.coordinates:[null,null];

    return {
      nom:String(selected.nom||cityName||requestedCity).trim(),
      code:String(selected.code).trim(),
      population:Number.isFinite(Number(selected.population))?Number(selected.population):null,
      surface:Number.isFinite(Number(selected.surface))?Number(selected.surface):null,
      centre:{type:"Point",coordinates:centre},
      departement:selected.departement||{code:String(selected.code).slice(0,2)},
      region:selected.region||null,
      epci:selected.epci||null
    };
  };

  if(postal){
    try{
      const url="https://geo.api.gouv.fr/communes?codePostal="+encodeURIComponent(postal)
        +"&fields=nom,code,population,surface,centre,departement,region,epci&format=json";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(5000)
      });
      if(response.ok){
        const rows=await response.json();
        const selected=chooseCandidate(rows);
        if(selected){
          console.log("JML commune résolue par code postal:",postal,selected.nom,selected.code);
          return selected;
        }
      }
    }catch(error){
      console.warn("JML résolution commune par code postal:",error.message);
    }
  }

  if(cityName){
    try{
      const url="https://geo.api.gouv.fr/communes?nom="+encodeURIComponent(cityName)
        +"&boost=population&fields=nom,code,population,surface,centre,departement,region,epci&format=json";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(5000)
      });
      if(response.ok){
        const rows=await response.json();
        const selected=chooseCandidate(rows);
        if(selected){
          console.log("JML commune résolue par nom:",cityName,selected.code);
          return selected;
        }
      }
    }catch(error){
      console.warn("JML résolution commune par nom:",error.message);
    }
  }

  const queries=[];
  const addQuery=value=>{
    const q=String(value||"").trim();
    if(q&&!queries.includes(q)) queries.push(q);
  };
  addQuery([requestedAddress,cityName].filter(Boolean).join(", "));
  addQuery([cityName,postal].filter(Boolean).join(", "));
  addQuery(cityName);

  for(const query of queries){
    try{
      const url="https://data.geopf.fr/geocodage/search?q="+encodeURIComponent(query)+"&limit=5";
      const response=await fetch(url,{
        headers:{"User-Agent":"JML-Projet-Vendeur/3.1.0","Accept":"application/json"},
        signal:AbortSignal.timeout(6000)
      });
      if(!response.ok) continue;
      const payload=await response.json();
      const features=Array.isArray(payload?.features)?payload.features:[];
      for(const feature of features){
        const p=feature?.properties||{};
        const code=String(p.citycode||p.cityCode||p.citycode_insee||"").trim();
        if(!/^\d{5}$/.test(code)) continue;
        const coords=feature?.geometry?.coordinates;
        const label=String(p.label||p.name||cityName).trim();
        const nom=String(p.city||p.commune||cityName).trim()||cityName;
        return {
          nom,code,population:null,surface:null,
          centre:{type:"Point",coordinates:Array.isArray(coords)&&coords.length>=2?coords:[null,null]},
          departement:{code:code.slice(0,2)},region:null,epci:null,
          geocodedLabel:label
        };
      }
    }catch(error){
      console.warn("JML résolution commune IGN:",query,error.message);
    }
  }

  return null;
}

app.get("/api/commune-market", async (req,res) => {
  const city=clean(req.query.city,100);
  if(!city) return res.status(400).json({
    ok:false,
    code:"JML-MARKET-400",
    error:"Commune requise."
  });
  try{
    const commune=await resolveTerritoryCommune(city,"");
    if(!commune) return res.status(422).json({
      ok:false,
      code:"JML-MARKET-422",
      error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
    });
    const market=await getCommuneMarketData(commune.nom,commune.code);
    return res.json({
      ok:true,
      ...market,
      commune:{code:commune.code,nom:commune.nom}
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    console.error("JML commune-market:",detail);
    return res.status(500).json({
      ok:false,
      code:"JML-MARKET-500",
      error:"Erreur lors du chargement du marché communal.",
      detail
    });
  }
});

app.get("/api/territory-commune", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  if(!city) return res.status(400).json({ok:false,code:"JML-COMMUNE-400",error:"Commune requise."});
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune) return res.status(422).json({
      ok:false,code:"JML-COMMUNE-422",
      error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
    });
    return res.json({
      ok:true,commune,
      source:"Géo API / Géoplateforme",
      diagnostics:{resolver:"geo.api.gouv.fr puis Géoplateforme",code:commune.code,name:commune.nom}
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    console.error("JML territory-commune:",detail);
    return res.status(500).json({ok:false,code:"JML-COMMUNE-500",error:"Erreur lors de la résolution de la commune.",detail});
  }
});

function normalizeAddress(value){
  return normalizeSearchCity(String(value||"").replace(/[0-9]+/g," ").replace(/\s+/g," "));
}
const geocodeCache=new Map();
async function geocodeAddress(address,city){
  const raw=String(address||"").trim(), commune=String(city||"").trim();
  if(!raw||!commune) return null;
  const key=normalizeSearchCity(raw+", "+commune);
  const cached=geocodeCache.get(key);
  if(cached && cached.expiresAt>Date.now()) return cached.value;
  try{
    const q=encodeURIComponent(raw+", "+commune);
    const response=await fetch("https://data.geopf.fr/geocodage/search?q="+q+"&limit=5",{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/3.4.0"},
      signal:AbortSignal.timeout(6000)
    });
    if(!response.ok) return null;
    const payload=await response.json();
    const feature=(Array.isArray(payload?.features)?payload.features:[]).find(x=>Array.isArray(x?.geometry?.coordinates)&&x.geometry.coordinates.length>=2);
    if(!feature) return null;
    const [lon,lat]=feature.geometry.coordinates.map(Number);
    const value=Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon,label:String(feature?.properties?.label||"").trim()}:null;
    geocodeCache.set(key,{expiresAt:Date.now()+24*60*60*1000,value});
    return value;
  }catch(error){ console.warn("JML géocodage adresse:",error.message); return null; }
}
function haversineKm(a,b){
  const lat1=Number(a?.lat),lon1=Number(a?.lon),lat2=Number(b?.lat),lon2=Number(b?.lon);
  if(![lat1,lon1,lat2,lon2].every(Number.isFinite)) return null;
  const r=6371, dLat=(lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return r*2*Math.atan2(Math.sqrt(x),Math.sqrt(Math.max(0,1-x)));
}
function classifyDvfType(value,code){
  const v=String(value||"").toLowerCase(), c=String(code||"").toLowerCase();
  if(/terrain|land|parcelle/.test(v)||c==="3") return "Terrain";
  if(/appartement|apartment|studio|duplex|loft/.test(v)||c==="2") return "Appartement";
  if(/maison|house/.test(v)||c==="1") return "Maison";
  return null;
}
function parseSaleDate(v){
  if(v instanceof Date&&!Number.isNaN(v.getTime())) return v;
  const raw=String(v??"").trim(); if(!raw) return null;
  const direct=new Date(raw); if(!Number.isNaN(direct.getTime())) return direct;
  const normalized=raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  const fr=normalized.match(/^(\d{1,2})[\s/-]+(janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)[a-z.]*[\s/-]+(\d{4})$/i);
  if(fr){
    const months={janvier:0,janv:0,fevrier:1,fevr:1,mars:2,avril:3,avr:3,mai:4,juin:5,juillet:6,juil:6,aout:7,septembre:8,sept:8,octobre:9,oct:9,novembre:10,nov:10,decembre:11,dec:11};
    const d=new Date(Number(fr[3]),months[fr[2]],Number(fr[1]));
    return d.getFullYear()===Number(fr[3])&&d.getMonth()===months[fr[2]]&&d.getDate()===Number(fr[1])?d:null;
  }
  return null;
}
function parseComparableNumber(value){
  if(value===null||value===undefined||value==="") return null;
  if(typeof value==="number") return Number.isFinite(value)?value:null;
  const raw=String(value).trim().replace(/\u00a0/g," ").replace(/\s/g,"").replace(",",".");
  const match=raw.match(/-?\d+(?:\.\d+)?/);
  if(!match) return null;
  const n=Number(match[0]);
  return Number.isFinite(n)?n:null;
}

function weightedMedian(rows){
  const usable=rows
    .map(x=>({value:Number(x.pricePerM2),weight:Math.max(1,Number(x.score)||0)}))
    .filter(x=>Number.isFinite(x.value)&&x.value>0)
    .sort((a,b)=>a.value-b.value);
  if(!usable.length) return null;
  const total=usable.reduce((s,x)=>s+x.weight,0);
  let acc=0;
  for(const x of usable){
    acc+=x.weight;
    if(acc>=total/2) return x.value;
  }
  return usable[usable.length-1].value;
}

function comparableConfidence(rows,stats){
  const n=rows.length;
  const tierA=rows.filter(x=>x.tierCode==="A").length;
  const tierB=rows.filter(x=>x.tierCode==="B").length;
  const avgSurfaceGap=n?rows.reduce((s,x)=>s+(x.surfaceGap||0),0)/n:null;
  const avgDistance=n?rows.reduce((s,x)=>s+(Number(x.distanceKm)||0),0)/n:null;
  const spread=stats.spreadPct;
  if(n>=6&&tierA>=3&&avgSurfaceGap!=null&&avgSurfaceGap<=0.12&&spread!=null&&spread<=25) return "Élevée";
  if(n>=4&&tierA+tierB>=3&&avgSurfaceGap!=null&&avgSurfaceGap<=0.18) return "Bonne";
  if(n>=3&&tierA+tierB>=2) return "Modérée";
  if(n>=2) return "Faible";
  return "Insuffisante";
}

function buildTemporalMarketIndex(rows){
  const byYear=new Map();
  for(const row of Array.isArray(rows)?rows:[]){
    const date=parseSaleDate(row?.date);
    const value=Number(row?.pricePerM2);
    if(!date||!Number.isFinite(value)||value<=0) continue;
    const year=date.getFullYear();
    if(!byYear.has(year)) byYear.set(year,[]);
    byYear.get(year).push(value);
  }
  const annual=[];
  for(const [year,values] of byYear.entries()){
    if(values.length<3) continue;
    values.sort((a,b)=>a-b);
    const median=values.length%2
      ? values[(values.length-1)/2]
      : (values[values.length/2-1]+values[values.length/2])/2;
    annual.push({year,count:values.length,median:Number(median)});
  }
  annual.sort((a,b)=>a.year-b.year);
  const reference=annual.slice().reverse().find(x=>x.count>=5)||annual.at(-1)||null;
  if(!reference) return {available:false,years:annual,referenceYear:null,referenceMedian:null};
  return {
    available:true,
    years:annual,
    referenceYear:reference.year,
    referenceMedian:Number(reference.median),
    method:"Médiane annuelle locale des ventes comparables, dernière année suffisamment fournie"
  };
}

function applyTemporalRevaluation(rows){
  const index=buildTemporalMarketIndex(rows);
  if(!index.available) return {rows,index};
  const referenceMedian=Number(index.referenceMedian);
  for(const row of rows){
    const date=parseSaleDate(row?.date);
    const year=date?.getFullYear();
    const annual=index.years.find(x=>x.year===year);
    const original=Number(row?.pricePerM2);
    if(!annual||!Number.isFinite(original)||original<=0){
      row.originalPricePerM2=Number.isFinite(original)?Number(original.toFixed(2)):null;
      row.temporalFactor=1;
      row.temporalRevalued=false;
      continue;
    }
    const rawFactor=referenceMedian/Number(annual.median);
    const factor=Math.max(0.85,Math.min(1.15,rawFactor));
    row.originalPricePerM2=Number(original.toFixed(2));
    row.temporalFactor=Number(factor.toFixed(4));
    row.pricePerM2=Number((original*factor).toFixed(2));
    row.temporalRevalued=year!==index.referenceYear;
    row.temporalReferenceYear=index.referenceYear;
    row.temporalReferenceMedian=Number(referenceMedian.toFixed(2));
    row.temporalYearMedian=Number(Number(annual.median).toFixed(2));
    row.temporalAdjustmentPct=Number(((factor-1)*100).toFixed(1));
    row.influenceReason=row.temporalRevalued
      ? (row.influenceReason||"")+" — valeur actualisée temporellement"
      : (row.influenceReason||"");
  }
  return {rows,index};
}

async function buildIndependentTemporalControl(property,communeCode){
  const type=classifyDvfType(property?.propertyType,"");
  const surface=parsePositiveNumber(property?.surface);
  if(!pool||!communeCode||!["Maison","Appartement"].includes(type)){
    return {available:false,method:"Contrôle temporel indépendant indisponible pour ce type de bien ou sans base PostgreSQL."};
  }
  try{
    const minSurface=surface!==null?surface*0.70:null;
    const maxSurface=surface!==null?surface*1.30:null;
    const result=await db(`SELECT EXTRACT(YEAR FROM sale_date)::int AS year,
      COUNT(*)::int AS transactions,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_m2) AS median
      FROM jml_dvf_sales
      WHERE commune_code=$1
        AND property_type=$2
        AND sale_date>=CURRENT_DATE-INTERVAL '72 months'
        AND price_per_m2>0
        AND ($3::float8 IS NULL OR surface BETWEEN $3 AND $4)
      GROUP BY EXTRACT(YEAR FROM sale_date)
      ORDER BY year`,[String(communeCode),type,minSurface,maxSurface]);
    const years=(result.rows||[]).map(x=>({
      year:Number(x.year),count:Number(x.transactions||0),median:Number(x.median)
    })).filter(x=>Number.isFinite(x.year)&&x.count>0&&Number.isFinite(x.median)&&x.median>0);
    const reference=years.slice().reverse().find(x=>x.count>=10)
      ||years.slice().reverse().find(x=>x.count>=5)
      ||null;
    if(!reference){
      return {
        available:false,type,
        surfaceBand:surface!==null?{min:Number(minSurface.toFixed(1)),max:Number(maxSurface.toFixed(1))}:null,
        years,
        method:"Contrôle temporel indépendant : pas assez de ventes annuelles dans la bande de surface."
      };
    }
    const capPct=15;
    const enriched=years.map(x=>{
      const rawFactor=reference.median/x.median;
      const factor=Math.max(1-capPct/100,Math.min(1+capPct/100,rawFactor));
      return {
        year:x.year,count:x.count,median:Math.round(x.median),
        rawFactor:Number(rawFactor.toFixed(4)),
        factor:Number(factor.toFixed(4)),
        adjustmentPct:Number(((factor-1)*100).toFixed(1))
      };
    });
    return {
      available:true,type,
      surfaceBand:surface!==null?{min:Number(minSurface.toFixed(1)),max:Number(maxSurface.toFixed(1))}:null,
      referenceYear:reference.year,referenceMedian:Math.round(reference.median),
      years:enriched,capPct,
      source:"DVF local JML / PostgreSQL — série indépendante",
      method:"Médiane annuelle des ventes DVF de la commune, même type et bande de surface ±30 %, indépendante des comparables retenus."
    };
  }catch(error){
    console.warn("JML contrôle temporel indépendant:",error.message);
    return {available:false,method:"Contrôle temporel indépendant indisponible temporairement.",error:String(error?.message||error).slice(0,240)};
  }
}

function parsePositiveNumber(value){
  if(value===null||value===undefined||value==="") return null;
  const n=Number(String(value).replace(/[^0-9,.-]/g,"").replace(/\s/g,"").replace(",","."));
  return Number.isFinite(n)&&n>0?n:null;
}
const dpeCache=new Map();
const dpeStreetRowsCache=new Map();
const localDpeCache=new Map();
let dpeImportRunning=false;
const ADEME_DPE_API="https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";
function dpeNorm(value){return normalizeAddress(String(value??"")).trim();}
function dpeStreetName(value){
  return dpeNorm(value)
    .replace(/^(rue|ru|avenue|av|boulevard|bd|chemin|ch|impasse|imp|place|pl|route|rte|allee|allée|quai|faubourg|fg|square|cours|passage|voie)\s+/,"")
    .trim();
}
function dpeNumber(value){const m=String(value??"").trim().match(/^(\d+[A-Za-z]?)/);return m?normalizeAddress(m[1]):"";}
function dpeImportPayload(row){
  const number=ademeText(row,["numero_voie_ban","numero_voie"]);
  const street=ademeText(row,["nom_rue_ban","nom_rue"]);
  const city=ademeText(row,["nom_commune_ban","nom_commune_brut","nom_commune"]);
  const postal=ademeText(row,["code_postal_ban","code_postal_brut","code_postal"]);
  const address=ademeText(row,["adresse_ban","adresse_complete_ban","adresse_brut","label_brut"]);
  const dpe=normalizeDpeLabel(row?.etiquette_dpe||row?.classe_bilan_dpe||row?.classe_conso_energie);
  const ges=normalizeDpeLabel(row?.etiquette_ges||row?.classe_estimation_ges);
  const date=ademeText(row,["date_etablissement_dpe","date_visite_diagnostiqueur"]);
  const surface=Number(row?.surface_habitable_logement||row?.surface_habitable);
  const dept=String(row?.code_departement_ban??"").trim();
  if(!row?.numero_dpe||!dpe)return null;
  const fullAddress=address||[number,street,postal,city].filter(Boolean).join(" ");
  return {numeroDpe:String(row.numero_dpe).trim(),dpe,ges:ges||null,date:date||null,address:fullAddress,number:number||"",street:street||"",city:city||"",postal:postal||"",dept,cityCode:ademeText(row,["code_insee_ban","code_insee_commune"]),surface:Number.isFinite(surface)&&surface>0?surface:null,x:Number(row?.coordonnee_cartographique_x_ban)||null,y:Number(row?.coordonnee_cartographique_y_ban)||null,addressNorm:dpeNorm(fullAddress),streetNorm:dpeStreetName(street),numberNorm:dpeNumber(number)};
}
async function getLocalDpeByAddress(address,city="",postal=""){
  if(!pool)return null;
  const raw=String(address||"").trim(); if(!raw)return null;
  const cacheKey=dpeNorm(raw)+"|"+dpeNorm(city)+"|"+String(postal||"").trim();
  if(localDpeCache.has(cacheKey))return localDpeCache.get(cacheKey);
  try{
    const targetPostal=String(postal||"").trim()||((raw.match(/\b(\d{5})\b/)||[])[1]||"");
    const targetNumber=dpeNumber(raw);
    const targetStreet=dpeStreetName(dpeNorm(raw).replace(/^\d+[A-Z]?\s*/,"").replace(/\b\d{5}\b/g,"").replace(dpeNorm(city),"").trim());
    const q=await db("SELECT numero_dpe,dpe,ges,dpe_date,address,number_text,street,city,postal_code,surface_habitable FROM jml_dpe WHERE ($1='' OR postal_code=$1) AND (($2<>'' AND number_norm=$2 AND street_norm=$3) OR ($3<>'' AND street_norm=$3) OR ($4<>'' AND address_norm=$4)) ORDER BY CASE WHEN $2<>'' AND number_norm=$2 AND street_norm=$3 THEN 0 ELSE 1 END, CASE WHEN dpe_date IS NULL THEN 1 ELSE 0 END, dpe_date DESC LIMIT 20",[targetPostal,targetNumber,targetStreet,dpeNorm(raw)]);
    if(!q.rowCount){localDpeCache.set(cacheKey,null);return null;}
    const exact=q.rows[0];
    const exactMatch=targetNumber&&targetStreet&&exact.number_norm===targetNumber&&exact.street_norm===targetStreet;
    const result={dpe:normalizeDpeLabel(exact.dpe),ges:normalizeDpeLabel(exact.ges),source:"ADEME DPE — base locale 08",address:exact.address||[exact.number_text,exact.street,exact.postal_code,exact.city].filter(Boolean).join(" "),matchScore:exactMatch?140:90,matchLevel:exactMatch?"Adresse exacte":"Voie + code postal",numeroDpe:exact.numero_dpe,date:exact.dpe_date,surface:exact.surface_habitable};
    localDpeCache.set(cacheKey,result);return result;
  }catch(error){console.warn("JML DPE local:",error.message);localDpeCache.set(cacheKey,null);return null;}
}
async function importAdemeDpeDepartment(department="08"){
  if(!pool||dpeImportRunning)return {ok:false,reason:"disabled-or-running"};
  const dep=String(department).replace(/\D/g,"").padStart(2,"0"); if(dep!=="08")return {ok:false,reason:"only-08-supported"};
  const existing=await db("SELECT COUNT(*)::int AS count FROM jml_dpe WHERE department_code=$1",[dep]);
  if(Number(existing.rows[0]?.count||0)>0)return {ok:true,alreadyImported:true,total:Number(existing.rows[0].count)};
  dpeImportRunning=true; let imported=0,offset=0;
  try{
    while(true){
      const url=new URL(ADEME_DPE_API); url.searchParams.set("size","1000"); url.searchParams.set("after",String(offset)); url.searchParams.set("code_postal_ban_in","08");
      url.searchParams.set("select","numero_dpe,date_etablissement_dpe,etiquette_dpe,etiquette_ges,surface_habitable_logement,adresse_ban,numero_voie_ban,nom_rue_ban,nom_commune_ban,code_postal_ban,code_insee_ban,code_departement_ban,coordonnee_cartographique_x_ban,coordonnee_cartographique_y_ban");
      const response=await fetch(url,{headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/3.7.0"},signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error("ADEME import HTTP "+response.status);
      const payload=await response.json(); const rows=Array.isArray(payload?.results)?payload.results:Array.isArray(payload?.data)?payload.data:[];
      if(!rows.length)break;
      const valid=rows.map(dpeImportPayload).filter(Boolean).filter(x=>x.dept==="8"||x.dept==="08"||String(x.postal).startsWith("08"));
      if(offset===0&&rows.length&&valid.length===0)throw new Error("Le filtre ADEME département 08 n'a pas renvoyé de données 08.");
      for(let i=0;i<valid.length;i+=200){
        const batch=valid.slice(i,i+200),values=[],params=[];
        batch.forEach((x,j)=>{const b=j*17;values.push("("+Array.from({length:17},(_,k)=>"$"+(b+k+1)).join(",")+")");params.push(x.numeroDpe,x.dpe,x.ges,x.date||null,x.address,x.number,x.street,x.city,x.postal,dep,x.cityCode||null,x.surface,x.x,x.y,x.addressNorm,x.streetNorm,x.numberNorm);});
        await db("INSERT INTO jml_dpe (numero_dpe,dpe,ges,dpe_date,address,number_text,street,city,postal_code,department_code,city_code,surface_habitable,ban_x,ban_y,address_norm,street_norm,number_norm) VALUES "+values.join(",")+" ON CONFLICT(numero_dpe) DO UPDATE SET dpe=EXCLUDED.dpe,ges=EXCLUDED.ges,dpe_date=EXCLUDED.dpe_date,address=EXCLUDED.address,number_text=EXCLUDED.number_text,street=EXCLUDED.street,city=EXCLUDED.city,postal_code=EXCLUDED.postal_code,department_code=EXCLUDED.department_code,city_code=EXCLUDED.city_code,surface_habitable=EXCLUDED.surface_habitable,ban_x=EXCLUDED.ban_x,ban_y=EXCLUDED.ban_y,address_norm=EXCLUDED.address_norm,street_norm=EXCLUDED.street_norm,number_norm=EXCLUDED.number_norm",params);
        imported+=batch.length;
      }
      offset+=rows.length; if(rows.length<1000)break;
    }
    localDpeCache.clear(); return {ok:true,alreadyImported:false,total:imported};
  }finally{dpeImportRunning=false;}
}

function normalizeDpeLabel(value){
  const m=String(value??"").toUpperCase().match(/\b([A-G])\b/);
  return m?m[1]:null;
}
function ademeText(row,keys){
  for(const key of keys){
    if(Object.prototype.hasOwnProperty.call(row,key)&&row[key]!=null&&String(row[key]).trim()!=="") return String(row[key]).trim();
  }
  return "";
}
function extractDpeFromAdemeRow(row){
  if(!row||typeof row!=="object")return null;
  const preferred=["classe_bilan_dpe","classe_conso_energie","Etiquette_DPE","Etiquette DPE","etiquette_dpe","classe_dpe","Classe_DPE","classe_energie"];
  for(const key of preferred){
    if(Object.prototype.hasOwnProperty.call(row,key)){
      const v=normalizeDpeLabel(row[key]); if(v)return v;
    }
  }
  for(const [key,value] of Object.entries(row)){
    if(/dpe|étiquette.*énerg|etiquette.*energ|classe.*energ/i.test(key)){
      const v=normalizeDpeLabel(value); if(v)return v;
    }
  }
  return null;
}
function ademeRowAddressParts(row){
  if(!row||typeof row!=="object")return {label:"",street:"",number:"",city:"",postal:"",cityCode:""};
  const banType=String(ademeText(row,["ban_type"])).toLowerCase();
  const useBan=/housenumber|locality/.test(banType)||!banType;
  const number=ademeText(row,useBan?["ban_housenumber","numero_voie_ban","numero_voie","num_voie"]:["numero_voie","numero_voie_ban","num_voie"]);
  const street=ademeText(row,useBan?["ban_street","nom_rue_ban","adresse_voie","nom_voie"]:["adresse_voie","nom_voie","nom_rue_ban","ban_street"]);
  const city=ademeText(row,useBan?["ban_city","nom_commune_ban","nom_commune_brut","nom_commune"]:["nom_commune_brut","nom_commune","nom_commune_ban","ban_city"]);
  const postal=ademeText(row,useBan?["ban_postcode","code_postal_ban","code_postal_brut","code_postal"]:["code_postal_brut","code_postal","code_postal_ban","ban_postcode"]);
  const cityCode=ademeText(row,["ban_citycode","code_insee_commune","code_commune"]);
  const label=ademeText(row,useBan?["ban_label","adresse_ban","label_brut","adresse_brut"]:["adresse_ban","label_brut","adresse_brut","ban_label"]);
  let parsedNumber=number,parsedStreet=street;
  if((!parsedNumber||!parsedStreet)&&label){
    const compact=String(label).replace(/\s+/g," ").trim();
    const beforePostal=compact.split(/\s+\d{5}\b/)[0].trim();
    const match=beforePostal.match(/^([0-9]+[A-Za-z]?(?:\s*(?:bis|ter|quater))?)\s+(.+)$/i);
    if(match){
      if(!parsedNumber)parsedNumber=match[1].trim();
      if(!parsedStreet)parsedStreet=match[2].trim();
    }
  }
  return {label,street:parsedStreet,number:parsedNumber,city,postal,cityCode};
}
function scoreAdemeAddress(row,address,city,postal=""){
  const parts=ademeRowAddressParts(row);
  const raw=String(address||"").trim();
  const target=normalizeAddress(raw);
  const targetCity=normalizeAddress(city);
  const targetNumber=(raw.match(/^\s*(\d+[A-Za-z]?)/)||[])[1]||"";
  const targetStreet=dpeStreetName(normalizeAddress(raw).replace(/^\d+[A-Z]?\s*/,"").replace(/\b\d{5}\b/g,"").replace(targetCity,"").trim());
  const rowStreet=dpeStreetName(parts.street);
  const rowNumber=normalizeAddress(parts.number);
  const rowCity=normalizeAddress(parts.city);
  const rowPostal=normalizeAddress(parts.postal);
  const rowLabel=normalizeAddress(parts.label);
  let score=0;
  if(parts.label&&rowLabel===target)score+=120;
  if(targetStreet&&rowStreet===targetStreet)score+=55;
  else if(targetStreet&&rowStreet&&(rowStreet.includes(targetStreet)||targetStreet.includes(rowStreet)))score+=35;
  if(targetNumber&&rowNumber===normalizeAddress(targetNumber))score+=45;
  if(targetCity&&rowCity===targetCity)score+=25;
  const targetPostal=String(postal||"").trim()||((raw.match(/\b(\d{5})\b/)||[])[1]||"");
  if(targetPostal&&rowPostal===normalizeAddress(targetPostal))score+=20;
  return {score,parts};
}

async function getAdemeStreetRows(postal,street,number="",streetQuery=""){
  const normalizedPostal=String(postal||"").trim();
  const streetName=dpeStreetName(street);
  const targetNumber=dpeNumber(number);
  const rawStreetQuery=String(streetQuery||"").trim();
  // 3e modification : on mémorise le lot ADEME au niveau rue + code postal.
  // Le numéro sert ensuite uniquement au rapprochement local ; il ne doit pas
  // limiter la collecte à un seul résultat ADEME.
  const key=normalizedPostal+"|"+streetName;
  if(!streetName||dpeStreetRowsCache.has(key)) return dpeStreetRowsCache.get(key)||[];
  const endpoint="https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";
  const queries=[...new Set([
    rawStreetQuery,
    streetName
  ])].filter(Boolean);

  try{
    let allRows=[];
    for(const query of queries){
      const url=new URL(endpoint);
      url.searchParams.set("size","100");
      url.searchParams.set("code_postal_ban_in",normalizedPostal);
      url.searchParams.set("q",query);
      url.searchParams.set("q_fields","adresse_ban");
      url.searchParams.set("select","numero_dpe,etiquette_dpe,etiquette_ges,date_etablissement_dpe,date_fin_validite_dpe,surface_habitable_logement,adresse_brut,adresse_ban,code_postal_ban,nom_commune_ban");
      url.searchParams.set("sort","-_score,-date_etablissement_dpe");
      const response=await fetch(url,{
        headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/3.9.2"},
        signal:AbortSignal.timeout(10000)
      });
      if(!response.ok){
        console.warn("JML DPE ADEME HTTP",response.status,normalizedPostal,query);
        continue;
      }
      const payload=await response.json().catch(()=>({}));
      const rows=Array.isArray(payload?.results)?payload.results:Array.isArray(payload?.data)?payload.data:[];
      console.log("JML DPE ADEME adresse:",normalizedPostal,query,"=>",rows.length,"résultats");
      allRows.push(...rows);
      if(rows.length) break;
    }
    const rows=allRows;
    dpeStreetRowsCache.set(key,rows);
    return rows;
  }catch(error){
    console.warn("JML DPE ADEME requête adresse:",error.message);
    dpeStreetRowsCache.set(key,[]);
    return [];
  }
}
async function getAdemeDpeByAddress(address,city="",postal=""){
  const local=await getLocalDpeByAddress(address,city,postal);
  if(local?.dpe)return local;
  const raw=String(address||"").trim(), normalized=normalizeAddress(raw);
  if(!normalized)return null;
  const targetPostalInput=String(postal||"").trim();
  const cacheKey=normalized+"|"+normalizeAddress(city)+"|"+targetPostalInput;
  if(dpeCache.has(cacheKey))return dpeCache.get(cacheKey);
  try{
    const targetNumber=(raw.match(/^\s*(\d+[A-Za-z]?)/)||[])[1]||"";
    const targetPostal=targetPostalInput || (raw.match(/\b(\d{5})\b/)||[])[1]||"";
    const targetCity=normalizeAddress(city);
    const targetStreet=dpeStreetName(normalizeAddress(raw).replace(/^\d+[A-Z]?\s*/,"").replace(/\b\d{5}\b/g,"").replace(targetCity,"").trim());
    let best=null,bestScore=-1;

    // Recherche déterministe par rue + code postal : on récupère un lot
    // ADEME puis on compare localement numéro, voie, ville et label BAN.
    if(targetPostal&&targetStreet){
      const rawStreetQuery=dpeNorm(raw).replace(/^\s*\d+[A-Z]?\s*/,"").replace(/\b\d{5}\b/g,"").replace(targetCity,"").trim();
      const rows=await getAdemeStreetRows(targetPostal,targetStreet,targetNumber,rawStreetQuery);
      for(const row of rows){
        const dpe=extractDpeFromAdemeRow(row); if(!dpe)continue;
        const match=scoreAdemeAddress(row,raw,city,targetPostal);
        if(match.score>bestScore){
          bestScore=match.score;
          best={dpe,source:"ADEME DPE",address:match.parts.label||[match.parts.number,match.parts.street,match.parts.postal,match.parts.city].filter(Boolean).join(" "),matchScore:match.score,matchLevel:match.score>=120?"Adresse exacte":match.score>=90?"Numéro + voie":match.score>=55?"Voie correspondante":"Commune seulement"};
        }
      }
    }

    // Secours textuel pour les adresses sans code postal ou lorsque BAN n'est pas
    // disponible dans la ligne ADEME.
    if(bestScore<90){
      const endpoint="https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines";
      const queries=[...new Set([
        [targetNumber,targetStreet,city].filter(Boolean).join(" "),
        [targetStreet,city].filter(Boolean).join(" "),
        [raw,city].filter(Boolean).join(" ")
      ])].filter(Boolean);
      for(const q of queries){
        const response=await fetch(endpoint+"?size=100&"+ "q="+encodeURIComponent(q),{
          headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/1.3"},
          signal:AbortSignal.timeout(7000)
        }).catch(()=>null);
        if(!response||!response.ok) continue;
        const payload=await response.json().catch(()=>({}));
        const rows=Array.isArray(payload?.results)?payload.results:Array.isArray(payload?.data)?payload.data:[];
        for(const row of rows){
          const dpe=extractDpeFromAdemeRow(row); if(!dpe)continue;
          const match=scoreAdemeAddress(row,raw,city,targetPostal);
          if(match.score>bestScore){
            bestScore=match.score;
            best={dpe,source:"ADEME DPE",address:match.parts.label||[match.parts.number,match.parts.street,match.parts.postal,match.parts.city].filter(Boolean).join(" "),matchScore:match.score,matchLevel:match.score>=120?"Adresse exacte":match.score>=90?"Numéro + voie":match.score>=55?"Voie correspondante":"Commune seulement"};
          }
        }
        if(bestScore>=120)break;
      }
    }

    const result=bestScore>=90?best:null;
    dpeCache.set(cacheKey,result);
    return result;
  }catch(error){
    console.warn("JML ADEME DPE:",error.message);
    dpeCache.set(cacheKey,null);
    return null;
  }
}

const dvfPlusFreshCache=new Map();

function normalizeDvfPlusRow(row, fallbackCity=""){
  const x=row?.properties && typeof row.properties==="object" ? row.properties : (row||{});
  const geometry=row?.geometry||x?.geometry||null;
  let lon=Number(x.longitude??x.lon??x.x);
  let lat=Number(x.latitude??x.lat??x.y);
  if((!Number.isFinite(lon)||!Number.isFinite(lat))&&geometry?.type==="Point"&&Array.isArray(geometry.coordinates)){
    lon=Number(geometry.coordinates[0]); lat=Number(geometry.coordinates[1]);
  }
  const date=String(x.datemut??x.date_mutation??x.dateMutation??"").slice(0,10);
  const price=parsePositiveNumber(x.valeurfonc??x.valeur_fonciere??x.valeurFonciere??x.price);
  const surface=parsePositiveNumber(x.sbati??x.surface_reelle_bati??x.surface);
  const land=parsePositiveNumber(x.sterr??x.surface_terrain??x.land_surface);
  const rooms=parsePositiveNumber(x.nblocapt??x.nbpiece??x.nombre_pieces_principales??x.rooms);
  const rawType=x.libtypbien??x.type_local??x.type??"";
  const rawTypeCode=String(x.codtypbien??x.code_type_local??"");
  const type=classifyDvfType(rawType,rawTypeCode==="111"?"1":rawTypeCode==="121"?"2":rawTypeCode);
  if(!date||price===null||price<=0||surface===null||surface<=0||!Number.isFinite(lat)||!Number.isFinite(lon)||!type)return null;
  const address=[
    x.adresse_numero??x.numero_voie,
    x.adresse_suffixe,
    x.adresse_nom_voie??x.nom_voie,
    x.code_postal,
    x.nom_commune??fallbackCity
  ].filter(v=>v!=null&&String(v).trim()!=="").join(" ").trim();
  return {
    id:String((x.idmutation??x.id_mutation??x.id) || [date,address,price,surface,lat,lon].join("|")),
    date,type,price,surface,rooms:rooms??null,land:land??null,lat,lon,address,
    street:String(x.adresse_nom_voie??x.nom_voie??x.street??"").trim(),
    postal:String(x.code_postal??"").trim(),
    code:String(x.code_insee??x.code_commune??"").trim(),
    city:String(x.nom_commune??x.libcommune??fallbackCity).trim(),
    pricePerM2:price/surface,
    source:"DVF+ Cerema"
  };
}

async function getFreshDvfPlusComparables(origin,property,communeCode=""){
  const lat=Number(origin?.lat),lon=Number(origin?.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon))return [];
  const type=classifyDvfType(property?.propertyType,"");
  if(type!=="Maison"&&type!=="Appartement")return [];
  const key=[lat.toFixed(4),lon.toFixed(4),type].join("|");
  const cached=dvfPlusFreshCache.get(key);
  if(cached&&cached.expiresAt>Date.now())return cached.rows;
  const half=0.009; // bbox < 0.02° imposé par l'API DVF+ ; environ 1 km autour du bien
  const url=new URL("https://apidf.cerema.fr/dvf_opendata/geomutations/");
  url.searchParams.set("in_bbox",[lon-half,lat-half,lon+half,lat+half].join(","));
  url.searchParams.set("anneemut_min",String(new Date().getFullYear()-1));
  url.searchParams.set("codtypbien",type==="Maison"?"111":"121");
  url.searchParams.set("fields","all");
  url.searchParams.set("page_size","500");
  url.searchParams.set("paginate","true");
  try{
    const response=await fetch(url,{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur-DVFPlus/1.0"},
      signal:AbortSignal.timeout(9000)
    });
    if(!response.ok)throw new Error("DVF+ Cerema HTTP "+response.status);
    const payload=await response.json().catch(()=>({}));
    const raw=Array.isArray(payload?.features)?payload.features:
      Array.isArray(payload?.results)?payload.results:
      Array.isArray(payload?.data)?payload.data:[];
    const cutoff=Date.now()-365*24*60*60*1000;
    const rows=raw.map(x=>normalizeDvfPlusRow(x,property?.city||"")).filter(Boolean).filter(x=>{
      const d=parseSaleDate(x.date);
      return d&&d.getTime()>=cutoff;
    });
    dvfPlusFreshCache.set(key,{expiresAt:Date.now()+60*60*1000,rows});
    console.log("JML DVF+ récent:",type,rows.length,"transactions <12 mois");
    return rows;
  }catch(error){
    console.warn("JML DVF+ récent indisponible:",String(error?.message||error));
    dvfPlusFreshCache.set(key,{expiresAt:Date.now()+15*60*1000,rows:[]});
    return [];
  }
}

async function buildComparableSales(market,property){
  const city=String(property?.city||market?.city||"").trim();
  const typeWanted=classifyDvfType(property?.propertyType,"");
  const surface=parsePositiveNumber(property?.surface);
  const landSurface=parsePositiveNumber(property?.landSurface ?? property?.terrain);
  const rooms=parsePositiveNumber(property?.rooms);
  const isLand=typeWanted==="Terrain";
  const targetSurface=isLand?landSurface:surface;

  let origin=await geocodeAddress(property?.address,city);
  let originSource="Adresse";
  let commune=null;
  try{ commune=await resolveTerritoryCommune(city,property?.address||""); }catch(_e){ commune=null; }
  if(!origin){
    try{
      const commune=await resolveTerritoryCommune(city,"");
      const coords=commune?.centre?.coordinates;
      if(Array.isArray(coords)&&coords.length>=2){
        origin={lat:Number(coords[1]),lon:Number(coords[0])};
        originSource="Centre de la commune";
      }
    }catch(_e){}
  }
  if(!origin) return {sales:[],valuationSales:[],sameStreet:[],median:null,weightedPriceM2:null,weightedMedianPriceM2:null,matchCount:0,totalCandidates:0,radiusKm:null,searchScope:"Localisation indisponible",origin:null,message:"Ni l'adresse ni le centre de la commune n'ont pu être géolocalisés."};

  const MAX_RADIUS_KM=3;
  const MAX_AGE_MONTHS=48;
  // Les données indispensables au calcul DVF passent avant tout enrichissement DPE.
  // Le DPE automatique ne doit jamais ralentir ni faire expirer la recherche de comparables.
  let subjectDpe=normalizeDpeLabel(property?.dpe)||null;
  let subjectDpeSource=subjectDpe?"Saisi dans le dossier":null;
  const [localResult,freshResult]=await Promise.all([
    getLocalDvfComparables(origin,MAX_RADIUS_KM,commune?.code||"",typeWanted).catch(error=>{
      console.warn("JML comparables DVF local:",error.message); return [];
    }),
    getFreshDvfPlusComparables(origin,property,commune?.code||"").catch(error=>{
      console.warn("JML comparables DVF+ récent:",error.message); return [];
    })
  ]);
  const local=Array.isArray(localResult)?localResult:[];
  const freshDvfPlus=Array.isArray(freshResult)?freshResult:[];

  const seen=new Set(),candidates=[];
  const now=Date.now();
  const streetKey=v=>normalizeAddress(v).replace(/\b\d+\b/g,"").trim();
  const ageMonths=v=>{const d=parseSaleDate(v);return d?Math.max(0,(now-d.getTime())/(30.4375*86400000)):99;};
  const clamp01=v=>Math.max(0,Math.min(1,v));
  const expSim=(diff,scale)=>Math.exp(-Math.abs(diff)/Math.max(0.0001,scale));

  const scoreSale=(sale)=>{
    if(typeWanted&&classifyDvfType(sale.type,sale.codtypbien||"")!==typeWanted)return null;
    const dist=parsePositiveNumber(sale.distanceKm);
    if(dist===null||dist>MAX_RADIUS_KM)return null;
    const saleSurface=parsePositiveNumber(sale.surface);
    const saleLand=parsePositiveNumber(sale.land);
    const saleRooms=parsePositiveNumber(sale.rooms);
    const comparableSurface=isLand?saleLand:saleSurface;
    if(targetSurface!==null&&comparableSurface===null)return null;
    const surfaceRatio=targetSurface!==null&&comparableSurface!==null?Math.abs(comparableSurface-targetSurface)/targetSurface:null;
    if(surfaceRatio!==null&&surfaceRatio>0.30)return null;

    // La surface de terrain est un signal secondaire : la surface DVF peut
    // correspondre à la parcelle cadastrale entière alors que le dossier vendeur
    // peut renseigner une cour, terrasse ou petite emprise. On ne rejette donc
    // jamais une maison comparable uniquement à cause du terrain.
    let landRatio=null;
    if(!isLand&&landSurface!==null&&saleLand!==null){
      landRatio=Math.abs(saleLand-landSurface)/Math.max(landSurface,1);
    }
    let roomDiff=null;
    if(!isLand&&rooms!==null&&saleRooms!==null){
      roomDiff=Math.abs(saleRooms-rooms);
      if(roomDiff>2)return null;
    }

    const age=ageMonths(sale.date);
    if(age>MAX_AGE_MONTHS)return null;
    const saleAddress=normalizeAddress(sale.address);
    const propertyAddress=normalizeAddress(property?.address);
    const sameAddress=!!saleAddress&&!!propertyAddress&&saleAddress===propertyAddress;
    const fresh12m=age<=12;

    const salePrice=parsePositiveNumber(sale.price);
    const salePriceM2=parsePositiveNumber(sale.pricePerM2);
    const effectivePriceM2=isLand?(saleLand!==null&&salePrice!==null?salePrice/saleLand:salePriceM2):salePriceM2;
    if(effectivePriceM2===null||effectivePriceM2<=0)return null;

    const distanceSim=Math.exp(-dist/0.75);
    const recencySim=Math.exp(-age/36);
    const surfaceSim=surfaceRatio===null?0.55:expSim(surfaceRatio,0.18);
    const roomsSim=isLand?0.65:(roomDiff===null?0.65:expSim(roomDiff,1.2));
    // Sous 100 m² renseignés, on neutralise le terrain dans le score :
    // il est trop sensible à la façon dont la parcelle a été déclarée dans DVF.
    const landSim=isLand?1:(landSurface!==null&&landSurface<100?0.65:(landRatio===null?0.65:expSim(landRatio,0.55)));
    const sameStreet=streetKey(sale.address)===streetKey(property?.address);

    const freshBonus=fresh12m?6:0;
    const exactBonus=sameAddress&&fresh12m&&surfaceRatio!==null&&surfaceRatio<=0.15?12:0;
    const raw=20+24*distanceSim+20*surfaceSim+12*roomsSim+10*landSim+9*recencySim+freshBonus+exactBonus+(sameStreet?5:0);
    const score=Math.round(Math.min(100,raw));
    return {...sale,pricePerM2:effectivePriceM2,score,sameStreet,sameAddress,fresh12m,surfaceGap:surfaceRatio,landGap:landRatio,roomDiff,ageMonths:Number(age.toFixed(1)),tierId:dist<=0.5?"A":dist<=1?"B":dist<=2?"C":"D",tier:dist<=0.5?"0–500 m":dist<=1?"500 m–1 km":dist<=2?"1–2 km":"2–3 km"};
  };

  const sourceRows=[...(Array.isArray(freshDvfPlus)?freshDvfPlus:[]),...(Array.isArray(market?.recentSales)?market.recentSales:[]),...(Array.isArray(local)?local:[])];
  const evaluateRows=rows=>{
    for(const sale of rows){
      const id=String(sale.id||[sale.date,sale.address,sale.price,sale.surface,sale.land,sale.lat,sale.lon].join("|"));
      if(seen.has(id))continue;
      seen.add(id);
      const distanceKm=haversineKm(origin,{lat:Number(sale.lat),lon:Number(sale.lon)});
      if(distanceKm==null)continue;
      const normalized={...sale,distanceKm:Number(distanceKm.toFixed(3))};
      const x=scoreSale(normalized);
      if(x)candidates.push(x);
    }
  };
  evaluateRows(sourceRows);

  let externalRows=0;
  // Secours DVF externe uniquement si les sources principales n'ont pas fourni
  // suffisamment de candidats. Ce secours est borné pour ne jamais bloquer le moteur.
  // Le secours externe est volontairement désactivé dans le chemin critique :
  // les ventes locales DVF doivent répondre d'abord. Il pourra être utilisé séparément
  // par le contrôle marché, sans retarder l'affichage des comparables.
  externalRows=0;

  if(!candidates.length) return {sales:[],valuationSales:[],sameStreet:[],median:null,weightedPriceM2:null,weightedMedianPriceM2:null,matchCount:0,totalCandidates:0,radiusKm:null,searchScope:"Aucune transaction comparable",origin,originSource,source:"DVF local JML / PostgreSQL",engineVersion:"8.4.0-PG-DVF-VALUATION-COMPARE"};

  // Revalorisation temporelle : chaque vente est ramenée au niveau de la
  // dernière année locale suffisamment documentée. Le facteur est plafonné à
  // +/-15 % pour éviter qu'une petite série locale déforme brutalement la valeur.
  const temporal=applyTemporalRevaluation(candidates);
  const temporalIndex=temporal.index;
  const temporalControl={
    available:false,
    method:"Contrôle temporel indépendant différé : le moteur priorise les ventes comparables DVF."
  };
  const rawValues=candidates.map(x=>x.pricePerM2).filter(Number.isFinite).sort((a,b)=>a-b);
  const medianRaw=rawValues.length%2?rawValues[(rawValues.length-1)/2]:(rawValues[rawValues.length/2-1]+rawValues[rawValues.length/2])/2;
  const q1Raw=rawValues[Math.floor((rawValues.length-1)*0.25)]??medianRaw;
  const q3Raw=rawValues[Math.floor((rawValues.length-1)*0.75)]??medianRaw;
  const iqrRaw=q3Raw-q1Raw,loRaw=q1Raw-1.5*iqrRaw,hiRaw=q3Raw+1.5*iqrRaw;

  for(const x of candidates){
    const ratio=x.pricePerM2/Math.max(1,medianRaw);
    const priceCoherence=clamp01(Math.exp(-Math.abs(Math.log(Math.max(0.05,ratio)))/0.55));
    const statisticalOutlier=x.pricePerM2<loRaw||x.pricePerM2>hiRaw;
    x.priceCoherence=Number(priceCoherence.toFixed(3));
    x.statisticalOutlier=statisticalOutlier;
    x.weight=Math.max(0.0001,(x.score/100)**2*(0.35+0.65*priceCoherence));
    x.influenceReason=statisticalOutlier?"Prix statistiquement atypique : influence réduite":priceCoherence<0.65?"Prix éloigné du centre local : influence modérée":"Prix cohérent avec le groupe de comparables";
  }

  candidates.sort((a,b)=>b.weight-a.weight||b.score-a.score);
  const top40=candidates.slice(0,40);
  // Le DPE est un enrichissement secondaire : il ne doit jamais bloquer le calcul DVF.
  // On limite donc la vérification aux 4 meilleurs comparables et on la lance en une seule vague.
  // Le prix, le minimum DVF et la valeur centrale sont déjà calculés à partir des données DVF.
  const dpeRows=top40.slice(0,4);
  const enriched=await Promise.all(dpeRows.map(async sale=>{
    try{
      const dpeAddress=[sale.address,sale.postal].filter(Boolean).join(" ").trim();
      const found=await getAdemeDpeByAddress(dpeAddress||sale.address,sale.city||city,sale.postal||"");
      sale.dpeChecked=true;
      return {sale,found};
    }catch(_e){
      sale.dpeChecked=true;
      return {sale,found:null};
    }
  }));
  for(const item of enriched){
    if(item.found?.dpe){
      item.sale.dpe=item.found.dpe;
      item.sale.dpeSource=item.found.source;
      if(subjectDpe){
        const diff=Math.abs(subjectDpe.charCodeAt(0)-item.sale.dpe.charCodeAt(0));
        item.sale.dpeMatch=diff===0?"Identique":diff===1?"Très proche":diff===2?"Proche":"Écarté";
      }
    }
  }
  const topValues=top40.map(x=>x.pricePerM2).filter(Number.isFinite).sort((a,b)=>a-b);
  const tq1=topValues[Math.floor((topValues.length-1)*0.25)],tq3=topValues[Math.floor((topValues.length-1)*0.75)];
  const tiqr=(tq3??0)-(tq1??0),tlo=(tq1??0)-1.5*tiqr,thi=(tq3??0)+1.5*tiqr;
  const filtered=top40.filter(x=>top40.length<5||x.pricePerM2>=tlo&&x.pricePerM2<=thi);
  const valuationSales=filtered.length>=4?filtered:top40;

  const weightedRows=valuationSales.filter(x=>Number.isFinite(x.pricePerM2)&&x.weight>0).slice().sort((a,b)=>a.pricePerM2-b.pricePerM2);
  const totalWeight=weightedRows.reduce((s,x)=>s+x.weight,0);
  let weightedMedianPriceM2=null,acc=0;
  for(const x of weightedRows){acc+=x.weight;if(acc>=totalWeight/2){weightedMedianPriceM2=x.pricePerM2;break;}}
  if(weightedMedianPriceM2===null&&weightedRows.length)weightedMedianPriceM2=weightedRows.at(-1).pricePerM2;

  const values=valuationSales.map(x=>Number(x.pricePerM2)).sort((a,b)=>a-b);
  const median=values.length?(values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2):null;
  const centralPriceM2=weightedMedianPriceM2??median;
  const radiusKm=top40.length?Math.max(...top40.map(x=>x.distanceKm)):null;
  const closeCount=top40.filter(x=>Number(x.distanceKm)<=0.5).length;
  const minPriceM2=values.length?Math.round(values[0]):null,maxPriceM2=values.length?Math.round(values[values.length-1]):null;
  const q1=values.length?values[Math.floor((values.length-1)*0.25)]:null,q3=values.length?values[Math.floor((values.length-1)*0.75)]:null;
  const spreadPct=median&&q1!=null&&q3!=null?Math.round((q3-q1)/median*1000)/10:null;
  const strictCount=top40.filter(x=>Number(x.distanceKm)<=0.5&&x.score>=70).length;
  const tierCounts={A:top40.filter(x=>x.tierId==="A").length,B:top40.filter(x=>x.tierId==="B").length,C:top40.filter(x=>x.tierId==="C").length,D:top40.filter(x=>x.tierId==="D").length};
  const outlierCount=top40.filter(x=>x.statisticalOutlier).length;

  let confidence="Faible";
  if(valuationSales.length>=10&&strictCount>=3&&(spreadPct===null||spreadPct<=35))confidence="Bonne";
  else if(valuationSales.length>=5&&strictCount>=1)confidence="Intermédiaire";

  let rangeLow=null,rangeHigh=null;
  if(centralPriceM2!==null){
    if(values.length>=5&&q1!==null&&q3!==null){rangeLow=q1;rangeHigh=q3;}
    else{const margin=confidence==="Faible"?.15:confidence==="Intermédiaire"?.12:.10;rangeLow=centralPriceM2*(1-margin);rangeHigh=centralPriceM2*(1+margin);}
  }

  const recentSales12m=candidates.filter(s=>s.fresh12m).sort((a,b)=>a.ageMonths-b.ageMonths);
  const exactRecentSale=recentSales12m.find(s=>s.sameAddress&&s.surfaceGap!==null&&s.surfaceGap<=0.15)||null;
  return {
    sales:top40,valuationSales,sameStreet:top40.filter(s=>s.sameStreet),
    recentSales12m,exactRecentSale,
    median:median!=null?Math.round(median):null,
    weightedPriceM2:centralPriceM2!=null?Math.round(centralPriceM2):null,
    weightedMedianPriceM2:weightedMedianPriceM2!=null?Math.round(weightedMedianPriceM2):null,
    minPriceM2:minPriceM2!=null?Math.round(minPriceM2):null,
    maxPriceM2:maxPriceM2!=null?Math.round(maxPriceM2):null,
    temporalRevaluation:{
      available:Boolean(temporalIndex?.available),
      referenceYear:temporalIndex?.referenceYear||null,
      referenceMedian:temporalIndex?.referenceMedian!=null?Math.round(Number(temporalIndex.referenceMedian)):null,
      years:Array.isArray(temporalIndex?.years)?temporalIndex.years.map(x=>({
        year:x.year,count:x.count,median:Math.round(Number(x.median))
      })):[],
      method:temporalIndex?.method||"Pas assez de ventes pour calculer une revalorisation temporelle locale.",
      capPct:15
    },
    temporalControl,
    matchCount:top40.length,totalCandidates:candidates.length,radiusKm,closeCount,minPriceM2,maxPriceM2,
    q1:q1!=null?Math.round(q1):null,q3:q3!=null?Math.round(q3):null,spreadPct,strictCount,
    confidence,rangeLow:rangeLow!=null?Math.round(rangeLow):null,rangeHigh:rangeHigh!=null?Math.round(rangeHigh):null,
    tierCounts,searchScope:top40.length?"0–3 km / 48 mois":"Aucun comparable répondant aux critères",origin,originSource,
    source:"DVF local JML / PostgreSQL",
    method:isLand?"Transactions DVF de terrains comparables : toutes les ventes compatibles sont d'abord scorées, puis pondérées par proximité, surface, récence et cohérence statistique du prix.":"Transactions DVF du même type : toutes les ventes compatibles jusqu'à 3 km / 48 mois sont d'abord scorées. Les 40 meilleurs comparables sont ensuite contrôlés statistiquement ; les prix atypiques restent visibles mais influencent moins la valeur.",
    criteria:{type:typeWanted||null,surface:surface||null,landSurface:landSurface||null,rooms:rooms||null,maxRadiusKm:MAX_RADIUS_KM},
    dpe:{label:subjectDpe,source:subjectDpeSource},
    engineVersion:"8.4.0-PG-DVF-VALUATION-COMPARE",
    diagnostics:{
      postgresRows:local.length,
      marketRows:Array.isArray(market?.recentSales)?market.recentSales.length:0,
      externalRows,
      candidateCount:candidates.length,
      top40:top40.length,
      valuationCount:valuationSales.length,
      strictCount,
      outlierCount,
      landComparison:!isLand&&landSurface!==null&&landSurface<100?"neutralise-sous-100m2":"actif",
      originSource,
      tierCounts,
      confidence,
      dpeCheckedCount:dpeRows.length,
      dpeFoundCount:dpeRows.filter(x=>Boolean(x.dpe)).length,
      dpeSource:"ADEME DPE"
    }
  };
}
const flatwayBenchmarkCache=new Map();

function flatwayNumber(value){
  const raw=String(value??"").replace(/[\u00a0\u202f\s]/g,"").replace(",",".");
  const n=Number(raw.replace(/[^\d.-]/g,""));
  return Number.isFinite(n)&&n>0?n:null;
}
function flatwaySlug(value){
  return normalizeSearchCity(value).replace(/\s+/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"");
}
function flatwayStreetFromAddress(address){
  return normalizeAddress(address).replace(/^\s+/,"").trim();
}
function flatwayExtractTypeBlock(text,type){
  const wanted=/appartement|studio|duplex|loft/i.test(type||"")?"Appartement":"Maison";
  const re=new RegExp(wanted+"\\s+Prix moyen au m²\\s+([0-9\\u00a0\\u202f ]+)\\s+€?\\s+de\\s+([0-9\\u00a0\\u202f ]+)\\s+€?\\s+à\\s+([0-9\\u00a0\\u202f ]+)\\s+€?","i");
  const m=String(text||"").match(re);
  if(!m)return null;
  const avg=flatwayNumber(m[1]),low=flatwayNumber(m[2]),high=flatwayNumber(m[3]);
  return avg?{type:wanted,priceM2:avg,lowM2:low,highM2:high}:null;
}
function flatwayText(html){
  return decodeBasicEntities(String(html||""))
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function flatwayFindStreetUrl(html,street){
  const wanted=normalizeSearchCity(street);
  if(!wanted)return null;
  const re=/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(String(html||"")))){
    const label=normalizeSearchCity(m[2].replace(/<[^>]+>/g," "));
    if(label===wanted || (label.includes(wanted)&&wanted.length>8) || (wanted.includes(label)&&label.length>8)){
      return new URL(m[1],"https://flatway.fr").href;
    }
  }
  return null;
}
async function fetchPublicHtml(url){
  const response=await fetch(url,{
    headers:{
      "Accept":"text/html,application/xhtml+xml",
      "User-Agent":"JML-Projet-Vendeur/3.5 (public-market-benchmark)"
    },
    signal:AbortSignal.timeout(9000)
  });
  if(!response.ok) return null;
  return await response.text();
}
async function getFlatwayMarketBenchmark({city,address,propertyType,postalCode}={}){
  const key="flatway-v2|"+normalizeSearchCity(city)+"|"+normalizeSearchCity(address)+"|"+normalizeSearchCity(propertyType);
  const cached=flatwayBenchmarkCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return {...cached.data,cache:true};

  const fallback={available:false,source:"Flatway",sourceUrl:"https://flatway.fr/estimation",level:null,priceM2:null,lowM2:null,highM2:null};
  try{
    let postal=String(postalCode||"").match(/\b\d{5}\b/)?.[0]||"";
    let geo=null;
    if(!postal && address && city) geo=await geocodeAddress(address,city);
    postal=postal || String(geo?.label||"").match(/\b\d{5}\b/)?.[0] || "";
    const communeCode=String((await resolveTerritoryCommune(city,address))?.code||"").trim();
    if(!postal || !/^\d{5}$/.test(communeCode)) return fallback;
    const dep=communeCode.slice(0,2);
    const cityUrl="https://flatway.fr/estimation/"+dep+"/"+flatwaySlug(city)+"-"+postal+"-"+communeCode;
    const cityHtml=await fetchPublicHtml(cityUrl);
    if(!cityHtml)return fallback;

    const typeBlock=flatwayExtractTypeBlock(flatwayText(cityHtml),propertyType);
    let best=typeBlock?{...typeBlock,level:"commune",sourceUrl:cityUrl}:null;

    const street=flatwayStreetFromAddress(address);
    const streetUrl=flatwayFindStreetUrl(cityHtml,street);
    if(streetUrl){
      const streetHtml=await fetchPublicHtml(streetUrl);
      if(streetHtml){
        const streetBlock=flatwayExtractTypeBlock(flatwayText(streetHtml),propertyType);
        if(streetBlock) best={...streetBlock,level:"rue",sourceUrl:streetUrl};
        const num=String(address||"").match(/^\s*(\d+[A-Za-z]?(?:\s*[-/]\s*\d+[A-Za-z]?)?)/)?.[1];
        if(num){
          const exactUrl=streetUrl.replace(/\/$/,"")+"/"+encodeURIComponent(num.replace(/\s+/g,""));
          const exactHtml=await fetchPublicHtml(exactUrl);
          if(exactHtml){
            const exactText=flatwayText(exactHtml);
            const exactIsHouse=/\bMaison\b/i.test(exactText.slice(0,900));
            const exactIsApartment=/\bAppartement\b|\bAppart\./i.test(exactText.slice(0,900));
            const wantedApartment=/appartement|studio|duplex|loft/i.test(propertyType||"");
            const typeMatches=wantedApartment?exactIsApartment:exactIsHouse;
            const exactBlock=typeMatches?flatwayExtractTypeBlock(exactText,propertyType):null;
            if(exactBlock) best={...exactBlock,level:"adresse",sourceUrl:exactUrl};
          }
        }
      }
    }
    const data=best?{
      available:true,source:"Flatway",sourceUrl:best.sourceUrl,level:best.level,
      priceM2:best.priceM2,lowM2:best.lowM2,highM2:best.highM2,
      note:best.level==="adresse"?"Repère public à l'adresse":"Repère public de rue/commune ; pas une estimation personnalisée saisie dans un formulaire."
    }:fallback;
    flatwayBenchmarkCache.set(key,{expiresAt:Date.now()+6*60*60*1000,data});
    return data;
  }catch(error){
    console.warn("JML Flatway benchmark:",error.message);
    flatwayBenchmarkCache.set(key,{expiresAt:Date.now()+30*60*1000,data:fallback});
    return fallback;
  }
}

app.get("/api/external-market-benchmarks", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  const propertyType=clean(req.query.propertyType,60);
  const surface=Number(req.query.surface);
  const jmlValue=Number(req.query.jmlValue);
  let postalCode=clean(req.query.postalCode,10).match(/\b\d{5}\b/)?.[0]||"";
  let communeCode="";
  if(!city) return res.status(400).json({ok:false,code:"JML-EXT-400",error:"Commune requise."});
  try{
    const commune=await resolveTerritoryCommune(city,address);
    communeCode=String(commune?.code||"").trim();
    if(!postalCode && address){
      const geo=await geocodeAddress(address,city);
      postalCode=String(geo?.label||"").match(/\b\d{5}\b/)?.[0]||"";
    }

    // Les estimateurs publics sont interrogés en parallèle. Nous ne remplissons
    // jamais une valeur avec une supposition : si une source ne répond pas,
    // elle reste simplement disponible via son lien de vérification manuelle.
    const publicSources=await getPublicMarketBenchmarks({
      city,address,propertyType,surface,postalCode,communeCode
    });

    const flatway=await getFlatwayMarketBenchmark({city,address,propertyType,postalCode});
    const sources=[...publicSources];
    if(flatway.available&&Number.isFinite(flatway.priceM2)&&flatway.priceM2>0){
      const value=Number.isFinite(surface)&&surface>0?Math.round(flatway.priceM2*surface):null;
      const low=Number.isFinite(surface)&&surface>0&&flatway.lowM2?Math.round(flatway.lowM2*surface):null;
      const high=Number.isFinite(surface)&&surface>0&&flatway.highM2?Math.round(flatway.highM2*surface):null;
      sources.push({
        id:"flatway",name:"Flatway",level:flatway.level,priceM2:flatway.priceM2,
        value,low,high,lowM2:flatway.lowM2,highM2:flatway.highM2,
        url:flatway.sourceUrl,note:flatway.note,automatic:true
      });
    }

    const externalValues=sources.map(x=>Number(x.value)).filter(v=>Number.isFinite(v)&&v>0);
    const vals=externalValues.concat(Number.isFinite(jmlValue)&&jmlValue>0?[jmlValue]:[]).sort((a,b)=>a-b);
    const median=vals.length?(vals.length%2?vals[(vals.length-1)/2]:(vals[vals.length/2-1]+vals[vals.length/2])/2):null;
    const extMedian=externalValues.length?(externalValues.length%2?externalValues[(externalValues.length-1)/2]:(externalValues[externalValues.length/2-1]+externalValues[externalValues.length/2])/2):null;
    const gap=extMedian&&Number.isFinite(jmlValue)&&jmlValue>0?((jmlValue/extMedian)-1)*100:null;
    const marketLow=sources.length?Math.min(...sources.map(x=>x.low).filter(Number.isFinite)):null;
    const marketHigh=sources.length?Math.max(...sources.map(x=>x.high).filter(Number.isFinite)):null;

    return res.json({
      ok:true,generatedAt:new Date().toISOString(),sources,
      externalCount:sources.length,externalMedian:extMedian,
      jmlValue:Number.isFinite(jmlValue)&&jmlValue>0?jmlValue:null,
      jmlGapPct:gap,
      synthesizedValue:median,
      marketLow,marketHigh,
      automaticCount:sources.filter(x=>x.automatic!==false).length,
      availableSources:sources.map(x=>x.name),
      confidence:sources.length>=3?"Bonne":sources.length===2?"Modérée":sources.length===1?(sources[0].level==="adresse"?"Modérée":"Indicative"):"Indisponible",
      note:sources.length
        ?"Les repères sont récupérés automatiquement depuis les pages publiques accessibles des estimateurs. Ils restent indicatifs. Les liens de vérification manuelle des 5 estimateurs sont conservés ci-dessous."
        :"Aucun repère externe public exploitable n'a pu être récupéré automatiquement pour cette adresse. Les 5 liens de vérification manuelle restent disponibles."
    });
  }catch(error){
    console.error("JML external-market-benchmarks:",error.message);
    return res.status(200).json({ok:false,code:"JML-EXT-DEGRADED",error:"Les repères externes sont temporairement indisponibles.",sources:[]});
  }
});

app.get("/api/territory-comparables", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  const propertyType=clean(req.query.propertyType,60);
  const surface=clean(req.query.surface,40);
  const landSurface=clean(req.query.landSurface ?? req.query.terrain,40);
  const rooms=clean(req.query.rooms,40);
  if(!city) return res.status(400).json({ok:false,code:"JML-COMP-400",error:"Commune requise."});
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune) return res.status(422).json({ok:false,code:"JML-COMP-422",error:"Commune introuvable."});
    // IMPORTANT : cet endpoint ne doit récupérer que les comparables.
    // Le marché communal est déjà chargé séparément par le navigateur.
    // Appeler getCommuneMarketData ici ajoutait une seconde récupération coûteuse
    // avant même de commencer la recherche DVF fine.
    const market={city:commune.nom,recentSales:[],transactions:null};
    const comparable=await buildComparableSales(market,{address,propertyType,surface,landSurface,rooms,city:commune.nom});
    return res.json({
      ok:true,version:VERSION,build:BUILD_MARKER,commune,
      comparables:comparable,
      source:"DVF local JML / PostgreSQL"
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    console.error("JML territory-comparables:",detail);
    return res.status(200).json({
      ok:false,code:"JML-COMP-DEGRADED",
      error:"Le moteur comparable est temporairement indisponible.",
      detail,
      comparables:{sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,totalCandidates:0,radiusKm:null,searchScope:"Indisponible",origin:null,message:"Les ventes communales restent disponibles ; la recherche fine sera réessayée."}
    });
  }
});

app.get("/api/territory-nearby", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  if(!city) return res.status(400).json({ok:false,code:"JML-NEARBY-400",error:"Commune requise."});
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune) return res.status(422).json({ok:false,code:"JML-NEARBY-422",error:"Commune introuvable."});
    const nearby=await getNearbyCommunes(commune);
    return res.json({ok:true,nearby,commune:{code:commune.code,nom:commune.nom}});
  }catch(error){
    console.warn("JML territory-nearby:",error.message);
    return res.status(200).json({ok:false,nearby:[],code:"JML-NEARBY-DEGRADED",message:"Les communes proches sont temporairement indisponibles."});
  }
});

app.get("/api/territory-summary", async (req,res) => {
  const city=clean(req.query.city,100);
  const address=clean(req.query.address,180);
  const propertyType=clean(req.query.propertyType,60);
  const surface=clean(req.query.surface,40);
  const landSurface=clean(req.query.landSurface ?? req.query.terrain,40);
  const rooms=clean(req.query.rooms,40);
  if(!city) return res.status(400).json({ok:false,error:"Commune requise."});

  let stage="resolve-commune";
  try{
    const commune=await resolveTerritoryCommune(city,address);
    if(!commune){
      console.warn("JML territory-summary: commune introuvable",{city,address});
      return res.status(422).json({
        ok:false,
        error:"Commune introuvable. Vérifiez le nom de la commune ou le code postal."
      });
    }

    stage="market";
    let market={
      city:commune.nom,found:false,source:"Données publiques",
      sourceUrl:"https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres/",
      message:"Les données de marché sont temporairement indisponibles.",
      recentSales:[],recentSalesSource:null,history:[],transactions:null,
      communalPrice:null,housePrice:null,apartmentPrice:null,terrainPrice:null,nearby:[]
    };
    try{
      market=await getCommuneMarketData(commune.nom,commune.code);
    }catch(error){
      console.warn("JML market isolated:",error.message);
    }

    stage="comparables";
    let comparable={
      sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,
      totalCandidates:0,radiusKm:null,searchScope:"Non disponible",origin:null,
      message:"Les comparables seront recherchés dès que l'adresse pourra être géolocalisée."
    };
    try{
      comparable=await Promise.race([
        buildComparableSales(market,{address,propertyType,surface,landSurface,rooms,city:commune.nom}),
        new Promise(resolve=>setTimeout(()=>resolve({
          sales:[],sameStreet:[],median:null,weightedPriceM2:null,matchCount:0,totalCandidates:0,
          radiusKm:null,searchScope:"Recherche trop lente — données communales conservées",origin:null,
          message:"La recherche fine autour de l’adresse a dépassé le délai. Les données communales restent disponibles."
        }),18000))
      ]);
    }catch(error){
      console.warn("JML comparables isolated:",error.message);
      comparable.message="La recherche de comparables est temporairement indisponible.";
    }

    let nearby=[];
    try{
      nearby=await getNearbyCommunes(commune);
    }catch(error){
      console.warn("JML nearby isolated:",error.message);
    }

    stage="external-market-control";
    // Contrôle indépendant : estimateurs publics + repère micro-secteur.
    // Les estimateurs externes ne remplacent jamais les ventes DVF ; ils servent
    // à détecter un biais de sous/surévaluation du moteur JML.
    let externalControl={
      available:false,sources:[],publicSources:[],microAddress:null,
      externalMedianM2:null,postalCode:null
    };
    try{
      let postalCode="";
      if(address){
        const geo=await geocodeAddress(address,commune.nom);
        postalCode=String(geo?.label||"").match(/\b\d{5}\b/)?.[0]||"";
      }
      const publicSources=await getPublicMarketBenchmarks({
        city:commune.nom,address,propertyType,surface,postalCode,communeCode:commune.code
      });
      let flatway=null;
      try{
        flatway=await getFlatwayMarketBenchmark({
          city:commune.nom,address,propertyType,postalCode
        });
      }catch(error){
        console.warn("JML micro-marché Flatway:",error.message);
      }
      const microAddress=flatway?.available&&flatway?.level==="adresse"&&Number.isFinite(Number(flatway.priceM2))
        ?flatway:null;
      const publicM2=publicSources
        .map(x=>Number(x.priceM2))
        .filter(v=>Number.isFinite(v)&&v>0)
        .sort((a,b)=>a-b);
      const publicMedianM2=publicM2.length
        ?(publicM2.length%2?publicM2[(publicM2.length-1)/2]:(publicM2[publicM2.length/2-1]+publicM2[publicM2.length/2])/2)
        :null;
      const fallbackFlatwayM2=flatway&&Number.isFinite(Number(flatway.priceM2))?Number(flatway.priceM2):null;
      const effectiveExternalM2=publicMedianM2??fallbackFlatwayM2;
      const sources=[...publicSources];
      if(flatway?.available&&Number.isFinite(Number(flatway.priceM2))){
        sources.push({
          id:"flatway",name:"Flatway",level:flatway.level,priceM2:Number(flatway.priceM2),
          lowM2:flatway.lowM2||null,highM2:flatway.highM2||null,url:flatway.sourceUrl,
          automatic:true,note:flatway.note
        });
      }
      externalControl={
        available:Boolean(effectiveExternalM2||microAddress),
        sources,publicSources,microAddress,
        externalMedianM2:effectiveExternalM2?Number(effectiveExternalM2):null,
        publicMedianM2:publicMedianM2?Number(publicMedianM2):null,
        postalCode:postalCode||null
      };
    }catch(error){
      console.warn("JML contrôle estimateurs externes:",error.message);
    }

    stage="seller-reference";
    // Calcul du repère vendeur : DVF comparables + micro-marché + contrôle externe.
    const propertyTypeText=String(propertyType||"").toLowerCase();
    const isSellerApartment=/appartement|studio|duplex|loft/i.test(propertyTypeText);
    const isSellerHouse=/maison/i.test(propertyTypeText);
    const isSellerLand=/terrain/i.test(propertyTypeText);
    const sellerType=isSellerApartment?"Appartement":isSellerHouse?"Maison":isSellerLand?"Terrain":"Tous biens";
    const sellerBase=isSellerApartment
      ? Number(market?.apartmentPrice)
      : isSellerHouse
        ? Number(market?.housePrice)
        : isSellerLand
          ? Number(market?.terrainPrice)
          : Number(market?.communalPrice);
    const sellerSurface=isSellerLand ? Number(landSurface) : Number(surface);
    const sellerHasBase=Number.isFinite(sellerBase)&&sellerBase>0;
    const sellerHasSurface=Number.isFinite(sellerSurface)&&sellerSurface>0;
    const comparableBase=Number(comparable?.weightedPriceM2);
    const comparableCount=Number(comparable?.valuationSales?.length || comparable?.matchCount || 0);
    const exactRecentSale=comparable?.exactRecentSale||null;
    const exactRecentSurface=Number(exactRecentSale?.surface);
    const exactRecentPrice=Number(exactRecentSale?.price);
    const exactRecentUsable=!!exactRecentSale&&Number.isFinite(exactRecentSurface)&&exactRecentSurface>0&&Number.isFinite(exactRecentPrice)&&exactRecentPrice>0&&sellerHasSurface&&Math.abs(exactRecentSurface-sellerSurface)/sellerSurface<=0.15;
    const useComparableReference=Number.isFinite(comparableBase)&&comparableBase>0&&comparableCount>=5;
    const microM2=Number(externalControl?.microAddress?.priceM2);
    const hasMicro=Number.isFinite(microM2)&&microM2>0;
    const externalM2=Number(externalControl?.externalMedianM2);
    const hasExternal=Number.isFinite(externalM2)&&externalM2>0;

    let referenceBase=null,referenceSource="",blend=null;
    if(exactRecentUsable){
      referenceBase=exactRecentPrice/exactRecentSurface;
      referenceSource="Vente DVF+ récente du bien";
      blend={method:"Vente exacte récente",components:[{source:"DVF+ vente exacte",weight:1,priceM2:referenceBase}],normalized:true};
    }else{
      // Pondération cible : DVF 50 % / micro-secteur 30 % / estimateurs 20 %.
      // Si une composante manque, son poids est automatiquement redistribué.
      const components=[];
      if(useComparableReference) components.push({source:"DVF comparables",targetWeight:0.50,priceM2:comparableBase});
      if(hasMicro) components.push({source:"Micro-marché / adresse",targetWeight:0.30,priceM2:microM2});
      if(hasExternal) components.push({source:"Estimateurs externes",targetWeight:0.20,priceM2:externalM2});
      const totalWeight=components.reduce((s,x)=>s+x.targetWeight,0);
      if(totalWeight>0){
        components.forEach(x=>{x.weight=x.targetWeight/totalWeight;});
        referenceBase=components.reduce((s,x)=>s+x.priceM2*x.weight,0);
        blend={
          method:"DVF comparables 50 % + micro-marché 30 % + estimateurs externes 20 %, poids redistribués si une source manque",
          components:components.map(x=>({source:x.source,weight:Number(x.weight.toFixed(3)),priceM2:Math.round(x.priceM2)})),
          normalized:true
        };
        referenceSource=components.length===3
          ?"DVF + micro-marché + estimateurs externes"
          :components.map(x=>x.source).join(" + ");
      }else if(sellerHasBase){
        referenceBase=sellerBase;
        referenceSource="Référence communale";
        blend={method:"Référence communale de secours",components:[{source:"Marché communal",weight:1,priceM2:sellerBase}],normalized:true};
      }
    }

    const sellerValue=sellerHasSurface&&Number.isFinite(referenceBase)&&referenceBase>0
      ?Math.round(referenceBase*sellerSurface)
      :null;
    const blendConfidence=exactRecentUsable
      ?"Élevée"
      :(useComparableReference&&hasMicro&&hasExternal&&externalControl.sources.length>=3
        ?"Bonne"
        :(useComparableReference&&(hasMicro||hasExternal)
          ?"Intermédiaire"
          :(referenceBase?"Indicative":"Indisponible")));
    const sellerReference={
      available:Number.isFinite(referenceBase)&&referenceBase>0,
      type:sellerType,
      basePriceM2:Number.isFinite(referenceBase)&&referenceBase>0?Math.round(referenceBase):null,
      surface:sellerHasSurface?sellerSurface:null,
      landSurface:isSellerLand&&sellerHasSurface?sellerSurface:(Number.isFinite(Number(landSurface))&&Number(landSurface)>0?Number(landSurface):null),
      referenceValue:sellerValue,
      range:{
        low:sellerValue!==null?Math.round(sellerValue*(blendConfidence==="Bonne"?0.88:0.85)):null,
        high:sellerValue!==null?Math.round(sellerValue*(blendConfidence==="Bonne"?1.12:1.15)):null,
        marginPct:blendConfidence==="Bonne"?12:15
      },
      transactions:useComparableReference?comparableCount:(Number.isFinite(Number(market?.transactions))?Number(market.transactions):null),
      communalTransactions:Number.isFinite(Number(market?.transactions))?Number(market.transactions):null,
      communalBasePriceM2:sellerBase,
      comparableBasePriceM2:Number.isFinite(comparableBase)&&comparableBase>0?Math.round(comparableBase):null,
      microMarketPriceM2:hasMicro?Math.round(microM2):null,
      externalMedianPriceM2:hasExternal?Math.round(externalM2):null,
      externalSources:externalControl.sources,
      valuationBlend:blend,
      confidence:blendConfidence,
      latestKnownSale:exactRecentUsable?{
        price:Math.round(exactRecentPrice),
        surface:Math.round(exactRecentSurface),
        date:exactRecentSale.date,
        source:"DVF+ Cerema"
      }:null,
      referenceSource,
      history:Array.isArray(market?.history)?market.history:[],
      comparables:comparable,
      explanation:sellerHasSurface&&Number.isFinite(referenceBase)&&referenceBase>0
        ?(exactRecentUsable
          ?"Vente DVF+ récente du bien retenue comme référence prioritaire."
          :(useComparableReference
            ?"Repère hybride : ventes DVF comparables en priorité, corrigées par le micro-marché lorsqu'un repère d'adresse est disponible et contrôlées par plusieurs estimateurs publics."
            :"Repère hybride de secours : estimateurs publics et marché communal, faute de volume suffisant de comparables DVF."))
        :"Le repère personnalisé sera calculé dès que le type de bien, la surface et les données de marché seront disponibles."
    };

    return res.json({
      ok:true,version:VERSION,build:BUILD_MARKER,commune,
      market:{...market,comparables:comparable},sellerReference,nearby,
      source:"API Géo + Géoplateforme IGN/BAN + DVF PostgreSQL",
      diagnostics:{
        communeResolver:"geo.api.gouv.fr par code postal/nom, puis Géoplateforme",
        communeCode:commune.code,communeName:commune.nom,
        market:!!market?.found,comparables:!!comparable,
        nearby:Array.isArray(nearby),
        marketSource:market?.source||null,
        marketRows:Array.isArray(market?.recentSales)?market.recentSales.length:0
      }
    });
  }catch(error){
    const detail=String(error?.message||error||"Erreur inconnue").slice(0,500);
    const code="JML-TERRITORY-500";
    console.error("JML territory-summary fatal:",{code,stage,detail,stack:error?.stack});
    return res.status(500).json({
      ok:false,
      error:"Erreur interne du module Mon secteur.",
      code,
      stage,
      detail,
      version:VERSION,
      build:BUILD_MARKER,
      diagnostics:{
        stage,
        likelySource:stage==="resolve-commune"?"Géo API / Géoplateforme":stage==="market"?"Marché / DVF PostgreSQL":stage==="comparables"?"Géocodage adresse / DVF PostgreSQL":"Calcul Mon secteur"
      }
    });
  }
});


const nearbyAssetsCache=new Map();

async function getGoogleNearbyAssets(lat,lon){
  const apiKey=String(process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||"").trim();
  if(!apiKey) return {
    available:false,configured:false,code:"JML-GOOGLE-NOT-CONFIGURED",
    source:"Google Places (New)",
    message:"Google Places n'est pas configuré sur Render."
  };
  const la=Number(lat),lo=Number(lon);
  const includedTypes=[
    "school","primary_school","secondary_school","university","college","kindergarten",
    "pharmacy","doctor","medical_clinic","hospital",
    "supermarket","grocery_store","convenience_store","shopping_mall",
    "bus_station","train_station","transit_station","parking",
    "park","playground","post_office","bank","library","restaurant","cafe"
  ];
  try{
    const response=await fetch("https://places.googleapis.com/v1/places:searchNearby",{
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "X-Goog-Api-Key":apiKey,
        "X-Goog-FieldMask":"places.displayName,places.location,places.types"
      },
      body:JSON.stringify({
        includedTypes,
        maxResultCount:20,
        rankPreference:"DISTANCE",
        locationRestriction:{circle:{center:{latitude:la,longitude:lo},radius:1500}}
      }),
      signal:AbortSignal.timeout(9000)
    });
    const body=await response.text();
    let payload={};
    try{payload=body?JSON.parse(body):{};}catch(_){}
    if(!response.ok){
      const detail=String(payload?.error?.message||body||("HTTP "+response.status)).slice(0,350);
      throw new Error("Google Places HTTP "+response.status+" — "+detail);
    }
    const categories={
      schools:{label:"Écoles & établissements",count:0,items:[]},
      commerces:{label:"Commerces de proximité",count:0,items:[]},
      transport:{label:"Transports & stationnement",count:0,items:[]},
      parks:{label:"Parcs, jeux & loisirs",count:0,items:[]},
      health:{label:"Santé",count:0,items:[]},
      services:{label:"Services du quotidien",count:0,items:[]}
    };
    const mapType=(types)=>{
      const t=Array.isArray(types)?types:[];
      if(t.some(x=>["school","primary_school","secondary_school","university","college","kindergarten"].includes(x))) return "schools";
      if(t.some(x=>["supermarket","grocery_store","convenience_store","shopping_mall"].includes(x))) return "commerces";
      if(t.some(x=>["bus_station","train_station","transit_station","parking"].includes(x))) return "transport";
      if(t.some(x=>["park","playground"].includes(x))) return "parks";
      if(t.some(x=>["pharmacy","doctor","medical_clinic","hospital"].includes(x))) return "health";
      return "services";
    };
    const distance=(p)=>{
      const plat=Number(p?.location?.latitude),plon=Number(p?.location?.longitude);
      const d=haversineKm({lat:la,lon:lo},{lat:plat,lon:plon});
      return d==null?999:d;
    };
    for(const place of (Array.isArray(payload?.places)?payload.places:[])){
      const d=distance(place),cat=mapType(place?.types);
      if(d>1.5||!categories[cat]) continue;
      const name=String(place?.displayName?.text||"Équipement Google").trim();
      categories[cat].count++;
      if(categories[cat].items.length<5) categories[cat].items.push({name,distanceKm:Number(d.toFixed(2))});
    }
    Object.values(categories).forEach(x=>x.items.sort((a,b)=>a.distanceKm-b.distanceKm));
    return {
      available:true,configured:true,provider:"Google Places (New)",
      source:"Google Places (New)",radiusKm:1.5,categories
    };
  }catch(error){
    return {
      available:false,configured:true,code:"JML-GOOGLE-PLACES",
      source:"Google Places (New)",
      message:"Google Places a répondu avec une erreur.",
      detail:String(error?.message||error||"Erreur").slice(0,350)
    };
  }
}

async function getNearbyAssets(lat,lon){
  const la=Number(lat),lo=Number(lon);
  if(!Number.isFinite(la)||!Number.isFinite(lo)) return {
    available:false,code:"JML-ASSET-NO-COORDS",
    message:"Coordonnées de l'adresse indisponibles."
  };
  const key=la.toFixed(5)+","+lo.toFixed(5);
  const cached=nearbyAssetsCache.get(key);
  if(cached&&cached.expiresAt>Date.now()) return cached.data;
  const q=`[out:json][timeout:8];
(
  nwr(around:1500,${la},${lo})[amenity~"^(school|kindergarten|childcare|college|university|pharmacy|doctors|clinic|hospital|post_office|bank|library|restaurant|cafe|parking)$"];
  way(around:5000,${la},${lo})[highway~"^(motorway|trunk|primary|secondary)$"];
  nwr(around:1500,${la},${lo})[shop];
  nwr(around:1500,${la},${lo})[highway=bus_stop];
  nwr(around:1500,${la},${lo})[railway~"^(station|halt|tram_stop)$"];
  nwr(around:1500,${la},${lo})[leisure~"^(park|playground|sports_centre|pitch|garden)$"];
  nwr(around:1500,${la},${lo})[tourism=picnic_site];
);
out center tags;`;
  const errors=[];
  try{
    const endpoints=[
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];
    let payload=null,usedEndpoint=null;
    for(const endpoint of endpoints){
      try{
        const response=await fetch(endpoint,{
          method:"POST",
          headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.3.2 (mon-secteur)"},
          body:"data="+encodeURIComponent(q),
          signal:AbortSignal.timeout(8000)
        });
        if(!response.ok) throw new Error("Overpass HTTP "+response.status);
        payload=await response.json(); usedEndpoint=endpoint; break;
      }catch(error){errors.push(endpoint+" → "+String(error?.message||error));}
    }
    if(!payload) throw new Error("Aucune instance Overpass disponible");
    const elements=Array.isArray(payload?.elements)?payload.elements:[];
    const out={
      available:true,source:"OpenStreetMap / Overpass",provider:"OpenStreetMap",
      radiusKm:1.5,categories:{
        schools:{label:"Écoles & établissements",count:0,items:[]},
        commerces:{label:"Commerces de proximité",count:0,items:[]},
        transport:{label:"Transports & stationnement",count:0,items:[]},
        roads:{label:"Grands axes routiers",count:0,items:[]},
        parks:{label:"Parcs, jeux & loisirs",count:0,items:[]},
        health:{label:"Santé",count:0,items:[]},
        services:{label:"Services du quotidien",count:0,items:[]}
      }
    };
    const add=(cat,name,dist,type)=>{const x=out.categories[cat];if(!x)return;x.count++;if(x.items.length<5)x.items.push({name:name||"Équipement sans nom",type:type||null,distanceKm:Number(dist.toFixed(2))});};
    const distance=(e)=>{const p=e?.center||e,x=Number(p?.lon??e?.lon),y=Number(p?.lat??e?.lat);const d=haversineKm({lat:la,lon:lo},{lat:y,lon:x});return d==null?999:d;};
    for(const e of elements){
      const t=e?.tags||{},d=distance(e),name=String(t.name||t.operator||"").trim();
      if(d>1.5 && !/^(motorway|trunk|primary|secondary)$/.test(String(t.highway||"")))continue;
      if(/^(motorway|trunk|primary|secondary)$/.test(String(t.highway||""))){
        const ref=String(t.ref||"").trim();
        const roadName=ref&&name?ref+" — "+name:(ref||name||"Grand axe routier");
        const roadType={motorway:"Autoroute",trunk:"Voie rapide",primary:"Route principale",secondary:"Axe départemental / secondaire"}[String(t.highway)]||"Grand axe routier";
        add("roads",roadName,d,roadType);
        continue;
      }
      if(["school","kindergarten","childcare","college","university"].includes(t.amenity))add("schools",name,d);
      else if(t.shop){
        const shopType={
          hypermarket:"Hypermarché",
          supermarket:"Supermarché",
          convenience:"Supérette",
          grocery:"Épicerie",
          deli:"Alimentation / épicerie fine",
          bakery:"Boulangerie"
        }[String(t.shop)]||String(t.shop);
        add("commerces",name,d,shopType);
      }
      else if(t.highway==="bus_stop"||["station","halt","tram_stop"].includes(t.railway)||t.amenity==="parking")add("transport",name,d);
      else if(["park","playground","sports_centre","pitch","garden"].includes(t.leisure)||t.tourism==="picnic_site")add("parks",name,d);
      else if(["pharmacy","doctors","clinic","hospital"].includes(t.amenity))add("health",name,d);
      else if(["post_office","bank","library","restaurant","cafe"].includes(t.amenity))add("services",name,d);
    }
    Object.values(out.categories).forEach(x=>x.items.sort((a,b)=>a.distanceKm-b.distanceKm));
    // Secours dédié pour les grands axes : indépendant des autres équipements.
    // Il permet d'afficher les axes même si la requête mixte OSM renvoie
    // correctement les services mais pas les ways routiers.
    if(!out.categories.roads.items.length){
      try{
        const roadQuery=`[out:json][timeout:8];
          way(around:5000,${la},${lo})[highway~"^(motorway|trunk|primary|secondary)$"];
          out center tags;`;
        for(const endpoint of endpoints){
          try{
            const rr=await fetch(endpoint,{
              method:"POST",
              headers:{"Content-Type":"application/x-www-form-urlencoded","User-Agent":"JML-Projet-Vendeur/3.3.2 (roads-fallback)"},
              body:"data="+encodeURIComponent(roadQuery),
              signal:AbortSignal.timeout(8000)
            });
            if(!rr.ok) continue;
            const rp=await rr.json();
            for(const e of (Array.isArray(rp?.elements)?rp.elements:[])){
              const t=e?.tags||{}, d=distance(e);
              if(!Number.isFinite(d)||d>5) continue;
              const ref=String(t.ref||"").trim();
              const roadName=String(t.name||"").trim();
              const title=ref&&roadName?ref+" — "+roadName:(ref||roadName||"Grand axe routier");
              const roadType={motorway:"Autoroute",trunk:"Voie rapide",primary:"Route principale",secondary:"Axe départemental / secondaire"}[String(t.highway)]||"Grand axe routier";
              if(!out.categories.roads.items.some(x=>x.name===title)){
                out.categories.roads.items.push({name:title,type:roadType,distanceKm:Number(d.toFixed(2))});
              }
            }
            if(out.categories.roads.items.length) break;
          }catch(_){}
        }
        out.categories.roads.items.sort((a,b)=>a.distanceKm-b.distanceKm);
        out.categories.roads.items=out.categories.roads.items.slice(0,5);
        out.categories.roads.count=out.categories.roads.items.length;
      }catch(_){}
    }
    out.endpoint=usedEndpoint;
    nearbyAssetsCache.set(key,{expiresAt:Date.now()+12*60*60*1000,data:out});
    return out;
  }catch(error){
    console.warn("JML équipements OSM:",error.message);
    const google=await getGoogleNearbyAssets(la,lo);
    if(google.available) return google;
    return {
      available:false,code:"JML-ASSET-SOURCES",
      source:"OpenStreetMap / Overpass → Google Places",
      message:"Les sources d'équipements ont échoué.",
      diagnostics:[
        ...errors.map(x=>({source:"OpenStreetMap / Overpass",code:"JML-OVERPASS",detail:x})),
        {source:"Google Places (New)",code:google.code||"JML-GOOGLE",detail:google.detail||google.message||"Non configuré"}
      ]
    };
  }
}

app.get("/api/territory-assets", async (req,res) => {
  const traceId="ASSET-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,7);
  const startedAt=Date.now();
  let lat=Number(req.query.lat), lon=Number(req.query.lon);
  const address=clean(req.query.address,180);
  const city=clean(req.query.city,100);
  console.log("[JML ASSETS]",traceId,"START",{city,address,hasCoords:Number.isFinite(lat)&&Number.isFinite(lon),code:req.query.code||null});
  try{
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      console.log("[JML ASSETS]",traceId,"STEP geocode:start");
      const geo=await geocodeAddress(address,city);
      console.log("[JML ASSETS]",traceId,"STEP geocode:end",geo?{lat:geo.lat,lon:geo.lon}:null,"ms",Date.now()-startedAt);
      if(geo){lat=Number(geo.lat);lon=Number(geo.lon);}
      else{
        console.log("[JML ASSETS]",traceId,"STEP commune-fallback:start");
        const commune=await resolveTerritoryCommune(city,address);
        console.log("[JML ASSETS]",traceId,"STEP commune-fallback:end",commune?{code:commune.code,nom:commune.nom}:null,"ms",Date.now()-startedAt);
        const coords=commune?.centre?.coordinates;
        if(!Array.isArray(coords)||coords.length<2){
          console.warn("[JML ASSETS]",traceId,"STOP localisation indisponible","ms",Date.now()-startedAt);
          return res.status(404).json({ok:false,available:false,error:"Localisation indisponible.",message:"La localisation du bien n'a pas pu être déterminée.",traceId});
        }
        lon=Number(coords[0]);lat=Number(coords[1]);
      }
    }
    let communeCode=clean(req.query.code,10);
    if(!/^\d{5}$/.test(communeCode)){
      console.log("[JML ASSETS]",traceId,"STEP commune-code:start");
      const commune=await resolveTerritoryCommune(city,address);
      communeCode=String(commune?.code||"");
      console.log("[JML ASSETS]",traceId,"STEP commune-code:end",communeCode||null,"ms",Date.now()-startedAt);
    }else{
      console.log("[JML ASSETS]",traceId,"STEP commune-code:provided",communeCode);
    }
    console.log("[JML ASSETS]",traceId,"STEP sources:start",{lat,lon,communeCode});
    const sourceStarted=Date.now();
    const [data,osm]=await Promise.all([
      getOfficialTerritoryAssets(lat,lon,communeCode).then(v=>{console.log("[JML ASSETS]",traceId,"SOURCE official:end",Date.now()-sourceStarted,"ms",v?.available,v?.code||"");return v;}),
      getNearbyAssets(lat,lon).then(v=>{console.log("[JML ASSETS]",traceId,"SOURCE osm/end",Date.now()-sourceStarted,"ms",v?.available,v?.code||"");return v;})
    ]);
    console.log("[JML ASSETS]",traceId,"STEP sources:end","ms",Date.now()-startedAt);
    const roads=osm?.available?osm.categories?.roads:null;
    const payload={
      ok:true,lat,lon,communeCode,...data,
      categories:{...(data.categories||{}),roads:roads||{label:"Grands axes routiers",count:0,items:[],available:false,source:"OpenStreetMap / Overpass"}},
      roadRadiusKm:5,
      roadSource:"OpenStreetMap / Overpass",
      traceId
    };
    console.log("[JML ASSETS]",traceId,"RESPONSE 200","ms",Date.now()-startedAt);
    return res.json(payload);
  }catch(error){
    console.warn("[JML ASSETS]",traceId,"ERROR",error?.message||error,"ms",Date.now()-startedAt);
    return res.status(200).json({ok:false,available:false,code:"JML-ASSET-OFFICIAL",message:"Les sources officielles d'équipements sont temporairement indisponibles.",source:"Éducation nationale + INSEE BPE 2025",traceId});
  }
});

app.get("/api/streetview", async (req,res) => {
  const address=clean(req.query.address,180);
  const city=clean(req.query.city,100);
  let lat=Number(req.query.lat), lon=Number(req.query.lon);
  if(!GOOGLE_STREETVIEW_API_KEY){
    return res.json({
      ok:true,available:false,code:"JML-STREETVIEW-NOT-CONFIGURED",
      message:"Street View n'est pas configuré sur ce serveur. Ajoutez GOOGLE_MAPS_API_KEY dans Render."
    });
  }
  try{
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      const geo=await geocodeAddress(address,city);
      if(geo){lat=Number(geo.lat);lon=Number(geo.lon);}
    }
    if(!Number.isFinite(lat)||!Number.isFinite(lon)){
      return res.status(422).json({ok:false,available:false,code:"JML-STREETVIEW-NO-LOCATION",message:"Adresse non géolocalisable."});
    }

    const location=encodeURIComponent(lat+","+lon);
    const metadataUrl="https://maps.googleapis.com/maps/api/streetview/metadata?location="+location+"&key="+encodeURIComponent(GOOGLE_STREETVIEW_API_KEY);
    const metadataResponse=await fetch(metadataUrl,{headers:{"Accept":"application/json"},signal:AbortSignal.timeout(7000)});
    if(!metadataResponse.ok){
      return res.status(502).json({ok:false,available:false,code:"JML-STREETVIEW-METADATA-HTTP",message:"Le service Street View n'a pas répondu correctement."});
    }
    const metadata=await metadataResponse.json();
    if(String(metadata?.status||"")!=="OK"){
      return res.json({
        ok:true,available:false,code:"JML-STREETVIEW-"+String(metadata?.status||"UNKNOWN"),
        message:"Aucune image Street View disponible à proximité de cette adresse.",
        lat,lon,status:metadata?.status||"UNKNOWN"
      });
    }

    const imageParams=new URLSearchParams({
      size:"640x360",
      location:lat+","+lon,
      fov:"90",
      pitch:"0",
      return_error_code:"true",
      key:GOOGLE_STREETVIEW_API_KEY
    });
    return res.json({
      ok:true,available:true,
      lat,lon,
      panoId:metadata.pano_id||null,
      date:metadata.date||null,
      copyright:metadata.copyright||"Google Maps",
      imageUrl:"https://maps.googleapis.com/maps/api/streetview?"+imageParams.toString(),
      mapsUrl:"https://www.google.com/maps/search/?api=1&query="+encodeURIComponent(lat+","+lon),
      source:"Google Maps / Street View"
    });
  }catch(error){
    console.warn("JML Street View:",error?.message||error);
    return res.status(200).json({
      ok:false,available:false,code:"JML-STREETVIEW-ERROR",
      message:"Street View est temporairement indisponible."
    });
  }
});

app.get("/api/territory-enrichment", async (req,res) => {
  const code=clean(req.query.code,10);
  const lat=Number(req.query.lat);
  const lon=Number(req.query.lon);
  if(!/^\d{5}$/.test(code)) return res.status(400).json({ok:false,error:"Code commune requis."});
  try{
    const commune={code,centre:{coordinates:[lon,lat]}};
    const [security,risks,environment]=await Promise.all([
      Promise.race([getSecurityData(code),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les données SSMSI prennent trop de temps à répondre.",year:2025}),14000))]),
      Promise.race([getGeoRisks(code),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les données Géorisques sont temporairement indisponibles."}),9000))]),
      Promise.race([getLocalEnvironment(commune),new Promise(resolve=>setTimeout(()=>resolve({available:false,message:"Les services locaux sont temporairement indisponibles."}),9000))])
    ]);
    return res.json({ok:true,security,risks,environment});
  }catch(error){
    console.warn("JML territory-enrichment:",error.message);
    return res.status(502).json({ok:false,error:"Enrichissements territoriaux temporairement indisponibles."});
  }
});

const cleanEmail = v => String(v ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g,"").trim().slice(0,180);
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(v));
const toBoolean = v => v === true || v === "true" || v === 1 || v === "1";
const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function sendLeadConfirmationEmail(lead, sellerSpaceUrl = "") {
  if (!lead.email) return { sent: false, reason: "no-email" };
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM || "").trim();
  if (!apiKey || !from) {
    console.warn("JML email confirmation non envoyée: RESEND_API_KEY ou RESEND_FROM manquant.");
    return { sent: false, reason: "email-provider-not-configured" };
  }
  const firstName = clean(lead.name, 120).split(/\s+/)[0] || "Bonjour";
  const subject = "Votre demande concernant votre projet immobilier";
  const text = "Bonjour " + firstName + ",\n\n" +
    "Nous avons bien reçu votre demande concernant votre projet immobilier dans les Ardennes.\n\n" +
    "Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.\n\n" + (sellerSpaceUrl ? "Votre espace vendeur personnel : " + sellerSpaceUrl + "\n\n" : "") +
    "À bientôt,\nJML Immobilier\nVotre projet, notre engagement";
  const safeName = firstName.replace(/[&<>"]/g, "");
  const html = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#f5f1e8;font-family:Arial,sans-serif;color:#26352f\">" +
    "<div style=\"max-width:620px;margin:30px auto;padding:0 16px\">" +
    "<div style=\"background:#173b32;padding:22px 24px;border-radius:12px 12px 0 0;color:#fff\"><div style=\"font-size:22px;font-weight:700\">JML Immobilier</div><div style=\"margin-top:5px;color:#d9bd72;font-size:13px\">VOTRE PROJET, NOTRE ENGAGEMENT</div></div>" +
    "<div style=\"background:#fff;padding:28px 24px;border-radius:0 0 12px 12px\"><p>Bonjour " + safeName + ",</p>" +
    "<p>Nous avons bien reçu votre demande concernant votre projet immobilier dans les Ardennes.</p>" +
    "<p>Merci pour votre confiance. Votre demande a bien été prise en compte. Nous reviendrons vers vous afin d’échanger simplement sur votre projet, votre bien et le calendrier que vous avez en tête.</p>" + (sellerSpaceUrl ? '<p style="margin:22px 0"><a href="' + sellerSpaceUrl.replace(/[&<>"]/g,"") + '" style="display:inline-block;padding:12px 18px;background:#d8bb7a;color:#173b32;text-decoration:none;border-radius:8px;font-weight:700">Ouvrir mon espace vendeur →</a></p>' : "") +
    "<p style=\"margin-top:28px\">À bientôt,<br><strong>JML Immobilier</strong><br><span style=\"color:#8c6d2d\">Votre projet, notre engagement</span></p></div></div></body></html>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [lead.email], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Resend " + response.status + ": " + detail.slice(0, 500));
  }
  const result = await response.json();
  return { sent: true, id: result.id || null };
}
const STATUS_VALUES = ["À qualifier","Contacté","À relancer","RDV pris","Estimation","Mandat","Pas de projet"];

function apiError(res, status, code, message, detail = null) {
  const payload = { ok:false, error:message, code };
  if (detail && process.env.NODE_ENV !== "production") payload.detail = String(detail);
  return res.status(status).json(payload);
}
function unexpected(res, code, message, err) {
  console.error(code, err);
  return apiError(res, 503, code, message, err?.message);
}

async function sendAppointmentConfirmationEmail(prospect, note = "", appointmentAt = null, appointmentLocation = "") {
  if (!prospect.email) return { sent: false, reason: "no-email" };
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.RESEND_FROM || "").trim();
  if (!apiKey || !from) {
    console.warn("JML email RDV non envoyé: RESEND_API_KEY ou RESEND_FROM manquant.");
    return { sent: false, reason: "email-provider-not-configured" };
  }
  const firstName = clean(prospect.name, 120).split(/\s+/)[0] || "Bonjour";
  const cleanNote = clean(note, 500);
  const subject = "Confirmation de votre rendez-vous — JML Immobilier";
  const appointmentDateText = appointmentAt ? new Date(appointmentAt).toLocaleString("fr-FR", { dateStyle:"full", timeStyle:"short", timeZone:"Europe/Paris" }) : "";
  const appointmentLine = appointmentDateText ? "\n\n📅 " + appointmentDateText : "";
  const locationLine = appointmentLocation ? "\n📍 " + appointmentLocation : "";
  const text = "Bonjour " + firstName + ",\n\n" +
    "Votre rendez-vous concernant votre projet immobilier a bien été enregistré avec JML Immobilier." +
    appointmentLine + locationLine +
    (cleanNote ? "\n\nInformations indiquées : " + cleanNote : "") +
    "\n\nNous pourrons échanger simplement sur votre bien, votre projet et les prochaines étapes.\n\n" +
    "À bientôt,\nJML Immobilier\nVotre projet, notre engagement";
  const safeName = firstName.replace(/[&<>"]/g, "");
  const safeNote = cleanNote.replace(/[&<>"]/g, "");
  const safeLocation = clean(appointmentLocation,250).replace(/[&<>"]/g, "");
  const dateHtml = appointmentDateText ? "<p><strong>📅 Rendez-vous :</strong><br>" + appointmentDateText + "</p>" : "";
  const locationHtml = safeLocation ? "<p><strong>📍 Lieu :</strong><br>" + safeLocation + "</p>" : "";
  const noteHtml = safeNote ? "<p><strong>Informations indiquées :</strong> " + safeNote + "</p>" : "";
  const html = "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>" +
    "<body style=\"margin:0;background:#f5f1e8;font-family:Arial,sans-serif;color:#26352f\"><div style=\"max-width:620px;margin:30px auto;padding:0 16px\">" +
    "<div style=\"background:#173b32;padding:22px 24px;border-radius:12px 12px 0 0;color:#fff\"><div style=\"font-size:22px;font-weight:700\">JML Immobilier</div><div style=\"margin-top:5px;color:#d9bd72;font-size:13px\">VOTRE PROJET, NOTRE ENGAGEMENT</div></div>" +
    "<div style=\"background:#fff;padding:28px 24px;border-radius:0 0 12px 12px\"><p>Bonjour " + safeName + ",</p>" +
    "<p><strong>Votre rendez-vous concernant votre projet immobilier a bien été enregistré.</strong></p>" + dateHtml + locationHtml + noteHtml +
    "<p>Nous pourrons échanger simplement sur votre bien, votre projet et les prochaines étapes.</p>" +
    "<p style=\"margin-top:28px\">À bientôt,<br><strong>JML Immobilier</strong><br><span style=\"color:#8c6d2d\">Votre projet, notre engagement</span></p></div></div></body></html>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [prospect.email], subject, text, html })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error("Resend " + response.status + ": " + detail.slice(0, 500));
  }
  const result = await response.json();
  return { sent: true, id: result.id || null };
}

async function db(sql, params = []) {
  if (!pool) throw new Error("DATABASE_URL manquante");
  return pool.query(sql, params);
}

function dbRequired(res) {
  if (!pool) {
    res.status(503).json({ ok:false, error:"PostgreSQL n'est pas configuré sur ce serveur." });
    return false;
  }
  return true;
}

async function initDb() {
  if (!pool) return;
  await db(`
    CREATE TABLE IF NOT EXISTS jml_prospects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT,
      phone TEXT,
      email TEXT,
      property_type TEXT NOT NULL DEFAULT 'Maison',
      horizon TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'Autre',
      status TEXT NOT NULL DEFAULT 'À qualifier',
      contact_basis TEXT NOT NULL DEFAULT 'À vérifier',
      contact_consent BOOLEAN NOT NULL DEFAULT FALSE,
      consent_at TIMESTAMPTZ,
      notes TEXT,
      score INTEGER,
      priority TEXT,
      reasons JSONB,
      next_action TEXT,
      next_action_at TIMESTAMPTZ,
      last_contact_at TIMESTAMPTZ,
      contact_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_activities (
      id TEXT PRIMARY KEY,
      prospect_id TEXT NOT NULL REFERENCES jml_prospects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      note TEXT,
      outcome TEXT,
      appointment_at TIMESTAMPTZ,
      appointment_location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_appointment_requests (
      id TEXT PRIMARY KEY,
      prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      requested_at TIMESTAMPTZ NOT NULL,
      requested_location TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'À traiter',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );


    CREATE TABLE IF NOT EXISTS jml_seller_spaces (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL UNIQUE,
      prospect_id TEXT REFERENCES jml_prospects(id) ON DELETE SET NULL,
      city TEXT,
      address TEXT,
      property_type TEXT,
      horizon TEXT,
      surface TEXT,
      rooms TEXT,
      dpe TEXT,
      terrain TEXT,
      owner_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      expected_price TEXT,
      sale_reason TEXT,
      already_estimated BOOLEAN,
      already_professional BOOLEAN,
      checklist JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      city TEXT,
      property_type TEXT,
      horizon TEXT,
      source TEXT NOT NULL DEFAULT 'Lead Magnet',
      consent BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jml_bpe_assets (
      id BIGSERIAL PRIMARY KEY,
      year INTEGER NOT NULL,
      commune_code TEXT NOT NULL,
      domain TEXT,
      subdomain TEXT,
      type_code TEXT,
      type_label TEXT,
      name TEXT,
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      address TEXT,
      source TEXT NOT NULL DEFAULT 'INSEE BPE 2025',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(year,commune_code,type_code,name,latitude,longitude)
    );
    CREATE INDEX IF NOT EXISTS idx_jml_bpe_commune ON jml_bpe_assets(commune_code);
    CREATE INDEX IF NOT EXISTS idx_jml_dvf_geo_date ON jml_dvf_sales(latitude,longitude,sale_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jml_dvf_type_geo_date ON jml_dvf_sales(property_type,latitude,longitude,sale_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jml_dvf_commune_type_date ON jml_dvf_sales(commune_code,property_type,sale_date DESC);
    CREATE INDEX IF NOT EXISTS idx_jml_bpe_geo ON jml_bpe_assets(latitude,longitude);

    CREATE TABLE IF NOT EXISTS jml_dvf_sales (
      id BIGSERIAL PRIMARY KEY, mutation_id TEXT NOT NULL, sale_date DATE,
      property_type TEXT NOT NULL, price NUMERIC NOT NULL, surface NUMERIC NOT NULL,
      rooms NUMERIC, land_surface NUMERIC, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
      address TEXT, street TEXT, postal_code TEXT, commune_code TEXT, commune_name TEXT, parcel_id TEXT,
      source_year INTEGER NOT NULL, price_per_m2 NUMERIC NOT NULL, source TEXT NOT NULL DEFAULT 'DVF',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(mutation_id,property_type,price,surface,address,parcel_id)
    );

    CREATE TABLE IF NOT EXISTS jml_dpe (
      numero_dpe TEXT PRIMARY KEY,
      dpe TEXT NOT NULL,
      ges TEXT,
      dpe_date DATE,
      address TEXT,
      number_text TEXT,
      street TEXT,
      city TEXT,
      postal_code TEXT,
      department_code TEXT NOT NULL,
      city_code TEXT,
      surface_habitable NUMERIC,
      ban_x DOUBLE PRECISION,
      ban_y DOUBLE PRECISION,
      address_norm TEXT,
      street_norm TEXT,
      number_norm TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const columns = {
    city:"TEXT",
    phone:"TEXT",
    email:"TEXT",
    property_type:"TEXT NOT NULL DEFAULT 'Maison'",
    horizon:"TEXT NOT NULL DEFAULT 'unknown'",
    source:"TEXT NOT NULL DEFAULT 'Autre'",
    status:"TEXT NOT NULL DEFAULT 'À qualifier'",
    contact_basis:"TEXT NOT NULL DEFAULT 'À vérifier'",
    contact_consent:"BOOLEAN NOT NULL DEFAULT FALSE",
    consent_at:"TIMESTAMPTZ",
    notes:"TEXT",
    score:"INTEGER",
    priority:"TEXT",
    reasons:"JSONB",
    next_action:"TEXT",
    next_action_at:"TIMESTAMPTZ",
    last_contact_at:"TIMESTAMPTZ",
    contact_count:"INTEGER NOT NULL DEFAULT 0",
    created_at:"TIMESTAMPTZ NOT NULL DEFAULT NOW()",
    updated_at:"TIMESTAMPTZ NOT NULL DEFAULT NOW()"
  };
  // Compatibilité avec les anciennes bases : le formulaire /api/leads doit fonctionner même si jml_leads existait avant les dernières colonnes.
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS name TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS email TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS phone TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS city TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS property_type TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS horizon TEXT`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'Lead Magnet'`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT FALSE`);
  await db(`ALTER TABLE jml_leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

  // Compatibilité avec les anciennes bases : toutes les colonnes utilisées par la création
  // de l'espace vendeur doivent exister avant /api/leads, sinon la transaction est annulée.
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS access_token TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS prospect_id TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS city TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS address TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS property_type TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS horizon TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS surface TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS rooms TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS dpe TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS terrain TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS owner_data JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS expected_price TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS sale_reason TEXT`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS already_estimated BOOLEAN`);
  await db(`ALTER TABLE jml_seller_spaces ADD COLUMN IF NOT EXISTS already_professional BOOLEAN`);

  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS outcome TEXT`);
  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS appointment_at TIMESTAMPTZ`);
  await db(`ALTER TABLE jml_activities ADD COLUMN IF NOT EXISTS appointment_location TEXT`);

  for (const [name,type] of Object.entries(columns)) {
    await db(`ALTER TABLE jml_prospects ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  await db(`
    UPDATE jml_prospects
    SET
      property_type = COALESCE(NULLIF(property_type,''),'Maison'),
      horizon = COALESCE(NULLIF(horizon,''),'unknown'),
      source = COALESCE(NULLIF(source,''),'Autre'),
      status = COALESCE(NULLIF(status,''),'À qualifier'),
      contact_basis = COALESCE(NULLIF(contact_basis,''),'À vérifier'),
      contact_count = COALESCE(contact_count,0),
      created_at = COALESCE(created_at,NOW()),
      updated_at = COALESCE(updated_at,NOW())
  `);

  await db(`
    DELETE FROM jml_prospects p
    USING jml_prospects d
    WHERE p.id <> d.id
      AND p.phone IS NOT NULL AND p.phone <> ''
      AND d.phone = p.phone
      AND p.id > d.id
  `);
  await db(`
    DELETE FROM jml_prospects p
    USING jml_prospects d
    WHERE p.id <> d.id
      AND p.email IS NOT NULL AND p.email <> ''
      AND LOWER(p.email) = LOWER(d.email)
      AND p.id > d.id
  `);

  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_commune_date ON jml_dvf_sales(commune_code,sale_date DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dpe_address ON jml_dpe(postal_code,street_norm,number_norm)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dpe_city ON jml_dpe(department_code,city_code)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dpe_date ON jml_dpe(dpe_date DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_geo_date ON jml_dvf_sales(latitude,longitude,sale_date DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_dvf_type_surface ON jml_dvf_sales(property_type,surface)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_updated ON jml_prospects(updated_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_status ON jml_prospects(status)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_prospects_next_action ON jml_prospects(next_action_at)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_activities_prospect ON jml_activities(prospect_id,created_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_leads_created ON jml_leads(created_at DESC)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_prospect ON jml_seller_spaces(prospect_id)");
  await db("CREATE INDEX IF NOT EXISTS idx_jml_seller_spaces_updated ON jml_seller_spaces(updated_at DESC)");
  await db("CREATE UNIQUE INDEX IF NOT EXISTS uq_jml_prospects_phone ON jml_prospects(phone) WHERE phone IS NOT NULL AND phone <> ''");
  await db("CREATE UNIQUE INDEX IF NOT EXISTS uq_jml_prospects_email ON jml_prospects(LOWER(email)) WHERE email IS NOT NULL AND email <> ''");
}

function normalizeProspect(body, existing = {}) {
  return {
    id: existing.id || newId(),
    name: clean(body.name ?? existing.name, 120),
    city: clean(body.city ?? existing.city, 100),
    phone: clean(body.phone ?? existing.phone, 40),
    email: cleanEmail(body.email ?? existing.email),
    property_type: clean(body.property_type ?? body.type ?? existing.property_type ?? "Maison", 60),
    horizon: clean(body.horizon ?? existing.horizon ?? "unknown", 20),
    source: clean(body.source ?? existing.source ?? "Autre", 80),
    status: clean(body.status ?? existing.status ?? "À qualifier", 40),
    contact_basis: clean(body.contact_basis ?? existing.contact_basis ?? "À vérifier", 60),
    contact_consent: toBoolean(body.contact_consent) || toBoolean(existing.contact_consent),
    consent_at: existing.consent_at || null,
    notes: clean(body.notes ?? existing.notes, 2000)
  };
}

function rowToProspect(r) {
  return {
    id:r.id,
    name:r.name,
    city:r.city || "",
    phone:r.phone || "",
    email:r.email || "",
    propertyType:r.property_type || "Maison",
    horizon:r.horizon || "unknown",
    source:r.source || "Autre",
    status:r.status || "À qualifier",
    contactBasis:r.contact_basis || "À vérifier",
    contactConsent:!!r.contact_consent,
    consentAt:r.consent_at || null,
    notes:r.notes || "",
    score:r.score ?? null,
    priority:r.priority || null,
    reasons:r.reasons || [],
    nextAction:r.next_action || null,
    nextActionAt:r.next_action_at || null,
    lastContactAt:r.last_contact_at || null,
    contactCount:r.contact_count || 0,
    createdAt:r.created_at,
    updatedAt:r.updated_at
  };
}

function scoreProspect(p) {
  let score = 20;
  const reasons = [];
  if(p.horizon === "0-3"){ score += 35; reasons.push("Projet annoncé dans les 3 mois"); }
  else if(p.horizon === "3-6"){ score += 25; reasons.push("Projet annoncé dans les 3 à 6 mois"); }
  else if(p.horizon === "6-12"){ score += 10; reasons.push("Projet identifié dans l'année"); }
  else reasons.push("Horizon à préciser");
  if(p.phone){ score += 10; reasons.push("Téléphone renseigné"); }
  if(p.email){ score += 5; reasons.push("Email renseigné"); }
  if(p.city){ score += 5; reasons.push("Commune renseignée"); }
  if(p.propertyType !== "Autre"){ score += 5; reasons.push("Type de bien identifié"); }
  if(p.source !== "Autre"){ score += 5; reasons.push("Source identifiée"); }
  if(p.contactBasis !== "À vérifier"){ score += 5; reasons.push("Base de contact renseignée"); }
  if(p.status === "RDV pris") score += 10;
  if(p.status === "Mandat") score = 100;
  score = Math.min(100, Math.max(0, score));
  const priority = score >= 75 ? "A" : score >= 50 ? "B" : "C";
  const nextAction = p.status === "Mandat" ? "Suivre le mandat et les prochaines étapes."
    : p.status === "RDV pris" ? "Préparer et confirmer le rendez-vous."
    : p.horizon === "0-3" ? "Prendre contact rapidement et proposer un rendez-vous."
    : p.horizon === "3-6" ? "Programmer une relance concrète sur le projet."
    : "Qualifier l'horizon puis programmer une prochaine action.";
  return {score,priority,reasons,nextAction};
}

app.get("/api/dpe/status", async (_req,res) => {
  if(!pool || !dbReady)return res.json({ok:true,ready:false,total:0,department:"08",source:"ADEME DPE"});
  try{
    const q=await db("SELECT COUNT(*)::int AS total,COUNT(DISTINCT city_code)::int AS communes,MAX(imported_at) AS imported_at FROM jml_dpe WHERE department_code='08'");
    return res.json({ok:true,ready:Number(q.rows[0]?.total||0)>0,total:Number(q.rows[0]?.total||0),communes:Number(q.rows[0]?.communes||0),importedAt:q.rows[0]?.imported_at||null,department:"08",source:"ADEME DPE — base locale"});
  }catch(error){return res.status(200).json({ok:false,ready:false,total:0,error:String(error?.message||error)});}
});
app.get("/api/dpe/import", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;
  if(String(req.query.department||"08")!=="08")return res.status(400).json({ok:false,error:"Seul le département 08 est activé."});
  try{return res.json(await importAdemeDpeDepartment("08"));}catch(error){console.error("JML ADEME DPE import:",error);return res.status(502).json({ok:false,error:String(error?.message||error)});}
});
app.get("/api/health", async (_req,res) => {
  let database = "memory";
  let databaseError = null;
  if(pool){
    try { await db("SELECT 1"); database = "postgres"; }
    catch(e){ database = "postgres-error"; databaseError = e.message; }
  }
  res.json({ok:true,app:"JML Projet Vendeur",version:VERSION,database,databaseReady:dbReady,databaseError,adminConfigured:!!ADMIN_PASSWORD,region:"Ardennes",sector:"Charleville-Mézières"});
});

app.get("/api/diagnostic", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  if(!pool) return res.json({ok:true,version:VERSION,database:"memory",prospects:memory.prospects.size,leads:memory.leads.size});
  try{
    const q=await db("SELECT COUNT(*)::int AS count FROM jml_prospects");
    const a=await db("SELECT COUNT(*)::int AS count FROM jml_activities");
    const l=await db("SELECT COUNT(*)::int AS count FROM jml_leads");
    const ss=await db("SELECT COUNT(*)::int AS count FROM jml_seller_spaces");
    const last=await db("SELECT id,name,created_at,updated_at FROM jml_prospects ORDER BY created_at DESC LIMIT 5");
    res.json({
      ok:true,
      version:VERSION,
      database:"postgres",
      prospects:q.rows[0].count,
      activities:a.rows[0].count,
      leads:l.rows[0].count,
      sellerSpaces:ss.rows[0].count,
      lastProspects:last.rows
    });
  }catch(e){
    res.status(503).json({ok:false,version:VERSION,database:"postgres-error",error:e.message});
  }
});

app.get("/api/pipeline", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){
      const q=await db("SELECT status,COUNT(*)::int AS count FROM jml_prospects GROUP BY status");
      const out=Object.fromEntries(STATUS_VALUES.map(s=>[s,0]));
      q.rows.forEach(r=>{ if(Object.prototype.hasOwnProperty.call(out,r.status)) out[r.status]=r.count; });
      return res.json({ok:true,pipeline:out});
    }
    const out=Object.fromEntries(STATUS_VALUES.map(s=>[s,0]));
    for(const p of memory.prospects.values()) out[p.status]=(out[p.status]||0)+1;
    res.json({ok:true,pipeline:out});
  }catch(e){ unexpected(res,"JML-P006","Pipeline indisponible.",e); }
});

app.post("/api/admin/login", async (req,res)=>{
  if(!ADMIN_PASSWORD) return apiError(res,503,"JML-AUTH-001","Accès professionnel non configuré. Ajoutez JML_ADMIN_PASSWORD dans Render.");
  const clientKey=String(req.ip||req.headers["x-forwarded-for"]||"unknown").split(",")[0].trim().slice(0,120);
  const nowMs=Date.now();
  const current=adminLoginAttempts.get(clientKey);
  if(current && nowMs-current.startedAt<ADMIN_LOGIN_WINDOW_MS && current.count>=ADMIN_LOGIN_MAX_ATTEMPTS){
    return res.status(429).json({ok:false,code:"JML-AUTH-004",error:"Trop de tentatives. Réessayez dans quelques minutes."});
  }
  if(!current || nowMs-current.startedAt>=ADMIN_LOGIN_WINDOW_MS) adminLoginAttempts.set(clientKey,{startedAt:nowMs,count:0});
  const password=String(req.body?.password||"");
  if(!password || password!==ADMIN_PASSWORD){
    const attempt=adminLoginAttempts.get(clientKey)||{startedAt:nowMs,count:0};
    attempt.count+=1; adminLoginAttempts.set(clientKey,attempt);
    return apiError(res,401,"JML-AUTH-003","Mot de passe incorrect.");
  }
  adminLoginAttempts.delete(clientKey);
  const token=createAdminSessionToken();
  setAdminSessionCookie(res,req,token);
  res.json({ok:true,expiresIn:ADMIN_SESSION_TTL_MS});
});
app.post("/api/admin/logout", async (req,res)=>{
  const token=getCookie(req,"jml_admin_session");
  if(token)adminSessions.delete(token);
  setAdminSessionCookie(res,req,"",0);
  res.json({ok:true});
});

app.get("/api/prospects", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){
      const q=await db("SELECT * FROM jml_prospects ORDER BY updated_at DESC, created_at DESC");
      return res.json({ok:true,persisted:true,prospects:q.rows.map(rowToProspect)});
    }
    res.json({ok:true,persisted:false,prospects:[...memory.prospects.values()].sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))});
  }catch(e){
    unexpected(res,"JML-P005","Lecture des prospects indisponible.",e);
  }
});

app.post("/api/prospects", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  const p=normalizeProspect(req.body||{});
  if(!p.name) return apiError(res,400,"JML-P001","Nom / prénom requis.");
  if(!validEmail(p.email)) return apiError(res,400,"JML-P002","Email invalide.");
  
  try{
    if(pool){
      const dup=await db(`SELECT id,name FROM jml_prospects
        WHERE (phone IS NOT NULL AND phone <> '' AND phone=$1)
           OR (email IS NOT NULL AND email <> '' AND LOWER(email)=LOWER($2))
        LIMIT 1`,[p.phone||null,p.email||null]);
      if(dup.rowCount) return apiError(res,409,"JML-P003","Ce prospect existe déjà dans le CRM.");
      const t=now();
      const consentAt=p.contact_consent?t:null;
      await db(`INSERT INTO jml_prospects
        (id,name,city,phone,email,property_type,horizon,source,status,contact_basis,contact_consent,consent_at,notes,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.contact_consent,consentAt,p.notes||null,t,t]);
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[p.id]);
      return res.status(201).json({ok:true,persisted:true,prospect:rowToProspect(q.rows[0])});
    }
    const out={...p,createdAt:now(),updatedAt:now()};
    memory.prospects.set(p.id,out);
    res.status(201).json({ok:true,persisted:false,prospect:out});
  }catch(e){
    if(e.code==="23505") return apiError(res,409,"JML-P003","Ce prospect existe déjà dans le CRM.");
    unexpected(res,"JML-P004","Enregistrement du prospect indisponible.",e);
  }
});

app.put("/api/prospects/:id/status", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  const status=clean(req.body?.status,40);
  if(!STATUS_VALUES.includes(status)) return apiError(res,400,"JML-P007","Statut invalide.");
  try{
    if(pool){
      const q=await db("UPDATE jml_prospects SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,status]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,prospect:rowToProspect(q.rows[0])});
    }
    const p=memory.prospects.get(req.params.id);
    if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    p.status=status;p.updatedAt=now();memory.prospects.set(p.id,p);
    res.json({ok:true,prospect:p});
  }catch(e){unexpected(res,"JML-P008","Modification du statut indisponible.",e);}
});

app.put("/api/prospects/:id", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){
      const old=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!old.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      const p=normalizeProspect(req.body||{},rowToProspect(old.rows[0]));
      if(!p.name) return apiError(res,400,"JML-P001","Nom / prénom requis.");
      if(!validEmail(p.email)) return apiError(res,400,"JML-P002","Email invalide.");
      const consentAt=p.contact_consent?(old.rows[0].consent_at||now()):null;
      await db(`UPDATE jml_prospects SET name=$2,city=$3,phone=$4,email=$5,property_type=$6,horizon=$7,source=$8,status=$9,contact_basis=$10,contact_consent=$11,consent_at=$12,notes=$13,updated_at=NOW() WHERE id=$1`,
        [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,p.contact_consent,consentAt,p.notes||null]);
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[p.id]);
      return res.json({ok:true,persisted:true,prospect:rowToProspect(q.rows[0])});
    }
    const old=memory.prospects.get(req.params.id);
    if(!old) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    const p=normalizeProspect(req.body||{},old);
    const out={...old,...p,updatedAt:now()};
    memory.prospects.set(p.id,out);
    res.json({ok:true,persisted:false,prospect:out});
  }catch(e){unexpected(res,"JML-P009","Modification indisponible.",e);}
});

app.post("/api/prospects/:id/qualify", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    let p;
    if(pool){
      const q=await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      p=rowToProspect(q.rows[0]);
    }else{
      p=memory.prospects.get(req.params.id);
      if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    }
    const q=scoreProspect(p);
    if(pool) await db("UPDATE jml_prospects SET score=$2,priority=$3,reasons=$4,next_action=$5,updated_at=NOW() WHERE id=$1",[p.id,q.score,q.priority,JSON.stringify(q.reasons),q.nextAction]);
    else memory.prospects.set(p.id,{...p,...q,updatedAt:now()});
    res.json({ok:true,...q});
  }catch(e){unexpected(res,"JML-P010","Qualification indisponible.",e);}
});

app.get("/api/prospects/:id/activities", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){
      const q=await db("SELECT id,type,note,outcome,appointment_at,appointment_location,created_at FROM jml_activities WHERE prospect_id=$1 ORDER BY created_at DESC LIMIT 100",[req.params.id]);
      return res.json({ok:true,activities:q.rows});
    }
    res.json({ok:true,activities:[]});
  }catch(e){unexpected(res,"JML-P011","Historique indisponible.",e);}
});

app.post("/api/prospects/:id/activity", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  const type=clean(req.body?.type,40);
  const note=clean(req.body?.note,1000);
  const outcome=clean(req.body?.outcome,80);
  const appointmentAtRaw=clean(req.body?.appointmentAt,60);
  const appointmentAt=appointmentAtRaw?new Date(appointmentAtRaw):null;
  const appointmentLocation=clean(req.body?.appointmentLocation,250);
  if(appointmentAt && Number.isNaN(appointmentAt.getTime())) return res.status(400).json({ok:false,error:"Date du rendez-vous invalide."});
  const allowedOutcomes=["Pas de réponse","Intéressé","À rappeler","RDV pris","Pas de projet","Refus"];
  if(outcome && !allowedOutcomes.includes(outcome)) return res.status(400).json({ok:false,error:"Résultat d'action invalide."});
  const allowed=["Appel","SMS","Email","RDV","Visite","Note"];
  if(!allowed.includes(type)) return res.status(400).json({ok:false,error:"Type d'action invalide."});
  try{
    if(pool){
      const exists=await db("SELECT id FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!exists.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      const id=newId(),t=now();
      await db("INSERT INTO jml_activities (id,prospect_id,type,note,outcome,appointment_at,appointment_location,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[id,req.params.id,type,note||null,outcome||null,appointmentAt,appointmentLocation||null,t]);
      if(["Appel","SMS","Email","RDV","Visite"].includes(type)){
        await db("UPDATE jml_prospects SET last_contact_at=$2,contact_count=contact_count+1,updated_at=NOW() WHERE id=$1",[req.params.id,t]);
      }
      let emailConfirmation = { sent: false, reason: "not-applicable" };
      if(outcome==="RDV pris") {
        await db("UPDATE jml_prospects SET status='RDV pris',next_action='Préparer et confirmer le rendez-vous.',next_action_at=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);
        const prospectResult = await db("SELECT * FROM jml_prospects WHERE id=$1",[req.params.id]);
        if(prospectResult.rowCount) {
          try {
            emailConfirmation = await sendAppointmentConfirmationEmail(rowToProspect(prospectResult.rows[0]), note, appointmentAt, appointmentLocation);
          } catch (emailErr) {
            console.error("JML appointment confirmation failed:", emailErr);
            emailConfirmation = { sent: false, reason: "send-failed" };
          }
        }
      }
      if(outcome==="Pas de projet"||outcome==="Refus") await db("UPDATE jml_prospects SET status='Pas de projet',next_action=NULL,next_action_at=NULL,updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="À rappeler") await db("UPDATE jml_prospects SET status='À relancer',next_action='Rappeler suite au dernier échange.',next_action_at=NOW()+INTERVAL '2 days',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="Intéressé") await db("UPDATE jml_prospects SET status='Contacté',next_action='Proposer un rendez-vous vendeur.',next_action_at=NOW()+INTERVAL '1 day',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(outcome==="Pas de réponse") await db("UPDATE jml_prospects SET status='À relancer',next_action='Nouvelle tentative de contact.',next_action_at=NOW()+INTERVAL '3 days',updated_at=NOW() WHERE id=$1",[req.params.id]);
      if(!["Appel","SMS","Email","RDV","Visite"].includes(type) && !outcome) await db("UPDATE jml_prospects SET updated_at=NOW() WHERE id=$1",[req.params.id]);
      return res.status(201).json({ok:true,activity:{id,type,note,outcome:outcome||null,created_at:t},emailConfirmation});
    }
    let emailConfirmation = { sent: false, reason: "not-applicable" };
    if(outcome==="RDV pris") {
      const prospect = memory.prospects.get(req.params.id);
      if(prospect) {
        try {
          emailConfirmation = await sendAppointmentConfirmationEmail(prospect, note);
        } catch (emailErr) {
          console.error("JML appointment confirmation failed:", emailErr);
          emailConfirmation = { sent: false, reason: "send-failed" };
        }
      }
    }
    res.status(201).json({ok:true,activity:{id:newId(),type,note,outcome:outcome||null,created_at:now()},emailConfirmation});
  }catch(e){unexpected(res,"JML-P012","Enregistrement de l'action indisponible.",e);}
});

app.put("/api/prospects/:id/follow-up", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  const nextAction=clean(req.body?.nextAction,500);
  const raw=req.body?.nextActionAt;
  const nextActionAt=raw?new Date(raw):null;
  if(nextActionAt && Number.isNaN(nextActionAt.getTime())) return res.status(400).json({ok:false,error:"Date de relance invalide."});
  try{
    if(pool){
      const q=await db("UPDATE jml_prospects SET next_action=$2,next_action_at=$3,updated_at=NOW() WHERE id=$1 RETURNING *",[req.params.id,nextAction||null,nextActionAt]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,prospect:rowToProspect(q.rows[0])});
    }
    const p=memory.prospects.get(req.params.id);
    if(!p) return res.status(404).json({ok:false,error:"Prospect introuvable."});
    p.nextAction=nextAction||null;p.nextActionAt=nextActionAt?p.nextActionAt=nextActionAt.toISOString():null;p.updatedAt=now();
    memory.prospects.set(p.id,p);
    res.json({ok:true,prospect:p});
  }catch(e){unexpected(res,"JML-P013","Programmation de la relance indisponible.",e);}
});

app.delete("/api/prospects/:id", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){
      const q=await db("DELETE FROM jml_prospects WHERE id=$1",[req.params.id]);
      if(!q.rowCount) return res.status(404).json({ok:false,error:"Prospect introuvable."});
      return res.json({ok:true,persisted:true});
    }
    memory.prospects.delete(req.params.id);
    res.json({ok:true,persisted:false});
  }catch(e){unexpected(res,"JML-P014","Suppression indisponible.",e);}
});


app.get("/api/appointment-requests", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(!pool) return res.json({ok:true,requests:[]});
    const q=await db("SELECT r.*, p.name AS prospect_name, p.status AS prospect_status FROM jml_appointment_requests r LEFT JOIN jml_prospects p ON p.id=r.prospect_id ORDER BY CASE WHEN r.status='À traiter' THEN 0 ELSE 1 END, r.created_at DESC");
    return res.json({ok:true,requests:q.rows});
  }catch(e){return unexpected(res,"JML-A011","Lecture des demandes de rendez-vous indisponible.",e);}
});

app.post("/api/appointment-requests/:id/confirm", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  const id=clean(req.params.id,100);
  try{
    if(!pool) return apiError(res,503,"JML-A012","PostgreSQL n'est pas configuré.");
    const q=await db("SELECT r.*, p.id AS pid, p.name AS pname, p.email AS pemail, p.phone AS pphone FROM jml_appointment_requests r LEFT JOIN jml_prospects p ON p.id=r.prospect_id WHERE r.id=$1",[id]);
    if(!q.rowCount) return apiError(res,404,"JML-A013","Demande de rendez-vous introuvable.");
    const r=q.rows[0];
    if(r.status!=="À traiter") return apiError(res,409,"JML-A014","Cette demande a déjà été traitée.");
    if(!r.pid) return apiError(res,409,"JML-A015","Cette demande n'est pas rattachée à un prospect.");
    const note=clean(req.body?.note,500);
    await db("INSERT INTO jml_activities (id,prospect_id,type,note,outcome,appointment_at,appointment_location,created_at) VALUES ($1,$2,'RDV',$3,'RDV pris',$4,$5,NOW())",[newId(),r.pid,"Rendez-vous confirmé depuis la demande vendeur."+(note?" "+note:""),r.requested_at,r.requested_location||null]);
    await db("UPDATE jml_prospects SET status='RDV pris',next_action='Préparer et confirmer le rendez-vous.',next_action_at=$2,updated_at=NOW() WHERE id=$1",[r.pid,r.requested_at]);
    await db("UPDATE jml_appointment_requests SET status='Confirmée' WHERE id=$1",[id]);
    let email={sent:false};
    try{email=await sendAppointmentConfirmationEmail({name:r.pname,email:r.pemail},note,r.requested_at,r.requested_location||"");}catch(e){console.warn("JML confirmation email demande RDV:",e);}
    return res.json({ok:true,status:"Confirmée",emailSent:!!email.sent});
  }catch(e){return unexpected(res,"JML-A016","Confirmation du rendez-vous indisponible.",e);}
});

app.post("/api/appointment-requests/:id/reject", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(!pool) return apiError(res,503,"JML-A017","PostgreSQL n'est pas configuré.");
    const q=await db("SELECT id,status FROM jml_appointment_requests WHERE id=$1",[req.params.id]);
    if(!q.rowCount) return apiError(res,404,"JML-A018","Demande de rendez-vous introuvable.");
    if(q.rows[0].status!=="À traiter") return apiError(res,409,"JML-A019","Cette demande a déjà été traitée.");
    await db("UPDATE jml_appointment_requests SET status='À revoir' WHERE id=$1",[req.params.id]);
    return res.json({ok:true,status:"À revoir"});
  }catch(e){return unexpected(res,"JML-A020","Traitement de la demande indisponible.",e);}
});

function parisParts(date=new Date()){
  const parts=new Intl.DateTimeFormat("fr-FR",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=name=>Number(parts.find(p=>p.type===name)?.value||0);
  return {year:get("year"),month:get("month"),day:get("day")};
}
function parisOffsetMinutes(date){
  const part=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",timeZoneName:"shortOffset",hour:"2-digit"}).formatToParts(date).find(p=>p.type==="timeZoneName");
  const m=String(part?.value||"GMT+1").match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if(!m) return 60;
  return (m[1]==="-"?-1:1)*(Number(m[2])*60+Number(m[3]||0));
}
function parisDateAt(daysFromToday,hour){
  const p=parisParts();
  const guess=Date.UTC(p.year,p.month-1,p.day+daysFromToday,hour,0,0);
  const first=new Date(guess);
  const offset=parisOffsetMinutes(first);
  return new Date(guess-offset*60000);
}
async function getBookedAppointmentTimes(){
  if(!pool) return [];
  const q=await db("SELECT requested_at FROM jml_appointment_requests WHERE status='À traiter' UNION ALL SELECT appointment_at AS requested_at FROM jml_activities WHERE outcome='RDV pris' AND appointment_at IS NOT NULL");
  return q.rows.map(r=>new Date(r.requested_at).getTime()).filter(Number.isFinite);
}
function availableSlotList(booked=[],busy=[]){
  const out=[], set=new Set(booked);
  for(let d=1;d<=21;d++){
    const day=parisDateAt(d,9);
    const weekday=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",weekday:"short"}).format(day);
    const dow=({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6})[weekday];
    if(dow===0 || dow===6) continue;
    const endHour=18;
    for(let h=9;h<endHour;h++){
      const dt=parisDateAt(d,h);
      const end=new Date(dt.getTime()+60*60*1000);
      if(dt.getTime()<=Date.now()) continue;
      const locallyBooked=set.has(dt.getTime());
      const calendarBusy=busy.some(b=>{
        const bs=new Date(b.start).getTime(), be=new Date(b.end).getTime();
        return Number.isFinite(bs)&&Number.isFinite(be)&&bs<end.getTime()&&be>dt.getTime();
      });
      if(!locallyBooked&&!calendarBusy) out.push(dt.toISOString());
    }
  }
  return out;
}
let appointmentCalendarCache={until:0,busy:[]};
async function getLiveAppointmentSlots(){
  const booked=await getBookedAppointmentTimes();
  const now=Date.now();
  let busy=[];
  if(appointmentCalendarCache.until>now){
    busy=appointmentCalendarCache.busy;
  }else{
    const start=parisDateAt(1,0);
    const end=parisDateAt(22,0);
    busy=await getGoogleCalendarBusy(pool,start,end);
    appointmentCalendarCache={until:now+60*1000,busy};
  }
  return availableSlotList(booked,busy);
}

app.get("/api/appointment-slots", async (_req,res) => {
  try{
    const slots=await getLiveAppointmentSlots();
    return res.json({
      ok:true,
      slots,
      timezone:"Europe/Paris",
      source:"Google Calendar",
      rules:"Du lundi au vendredi de 9h à 18h, samedi de 9h à 13h. Les créneaux occupés dans Google Calendar, déjà demandés ou confirmés sont masqués."
    });
  }catch(e){
    return unexpected(res,"JML-A021","Lecture des créneaux Google Calendar indisponible.",e);
  }
});

app.post("/api/public-appointment", async (req,res) => {
  const b=req.body||{};
  const prospectId=clean(b.prospectId,100);
  const name=clean(b.name,120);
  const email=cleanEmail(b.email);
  const phone=clean(b.phone,40);
  const city=clean(b.city,100);
  const requestedAtRaw=clean(b.requestedAt,60);
  const requestedLocation=clean(b.requestedLocation,250);
  const message=clean(b.message,1000);
  if(!name) return apiError(res,400,"JML-A001","Nom requis.");
  if(!email&&!phone) return apiError(res,400,"JML-A002","Email ou téléphone requis.");
  if(!validEmail(email)) return apiError(res,400,"JML-A003","Email invalide.");
  if(!requestedAtRaw) return apiError(res,400,"JML-A004","Date et créneau souhaités requis.");
  const requestedAt=new Date(requestedAtRaw);
  if(Number.isNaN(requestedAt.getTime())) return apiError(res,400,"JML-A005","Date du rendez-vous invalide.");
  if(requestedAt.getTime()<Date.now()-5*60*1000) return apiError(res,400,"JML-A006","Le créneau demandé est déjà passé.");
  let requestedSlots;
  try{
    requestedSlots=await getLiveAppointmentSlots();
  }catch(calendarError){
    return apiError(res,503,"JML-A008","Le calendrier Google est momentanément indisponible. Merci de réessayer dans quelques instants.");
  }
  if(!requestedSlots.includes(requestedAt.toISOString())) return apiError(res,409,"JML-A007","Ce créneau n’est plus disponible. Choisissez-en un autre.");
  try{
    if(pool){
      const exists=prospectId?await db("SELECT id FROM jml_prospects WHERE id=$1",[prospectId]):{rowCount:0};
      const id=newId();
      await db(
        "INSERT INTO jml_appointment_requests (id,prospect_id,name,email,phone,city,requested_at,requested_location,message,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'À traiter')",
        [id,exists.rowCount?prospectId:null,name,email||null,phone||null,city||null,requestedAt,requestedLocation||null,message||null]
      );
      if(exists.rowCount){
        await db(
          "INSERT INTO jml_activities (id,prospect_id,type,note,outcome,created_at) VALUES ($1,$2,'RDV',$3,'À rappeler',$4)",
          [newId(),prospectId,"Demande de rendez-vous vendeur · "+requestedAt.toLocaleString("fr-FR",{dateStyle:"full",timeStyle:"short",timeZone:"Europe/Paris"})+(requestedLocation?" · "+requestedLocation:"")+(message?" · "+message:""),now()]
        );
        await db("UPDATE jml_prospects SET status='À relancer',next_action='Traiter la demande de rendez-vous vendeur.',next_action_at=NOW(),updated_at=NOW() WHERE id=$1",[prospectId]);
      }
      return res.status(201).json({ok:true,id,linkedToProspect:!!exists.rowCount,status:"À traiter"});
    }
    return res.status(503).json({ok:false,error:"Le stockage des demandes de rendez-vous n'est pas disponible."});
  }catch(e){return unexpected(res,"JML-A010","Enregistrement de la demande de rendez-vous indisponible.",e);}
});


function newSellerSpaceToken(){ return crypto.randomBytes(32).toString("hex"); }

async function createSellerSpace(data, prospectId, transactionClient = null){
  const space={
    id:newId(), accessToken:newSellerSpaceToken(), prospectId:prospectId||null,
    city:clean(data.city,100), address:clean(data.address,180), propertyType:clean(data.propertyType,60),
    horizon:clean(data.horizon,20), surface:clean(data.surface,40), rooms:clean(data.rooms,40),
    dpe:clean(data.dpe,10), terrain:clean(data.terrain,40), ownerData:Array.isArray(data.ownerData)?data.ownerData.slice(0,10):[], expectedPrice:clean(data.expectedPrice,30), saleReason:clean(data.saleReason,1000), alreadyEstimated:typeof data.alreadyEstimated==="boolean"?data.alreadyEstimated:null, alreadyProfessional:typeof data.alreadyProfessional==="boolean"?data.alreadyProfessional:null, checklist:[], createdAt:now(), updatedAt:now()
  };
  if(pool){
    const runQuery = transactionClient ? transactionClient.query.bind(transactionClient) : db;
    await runQuery(
      `INSERT INTO jml_seller_spaces
       (id,access_token,prospect_id,city,address,property_type,horizon,surface,rooms,dpe,terrain,owner_data,expected_price,sale_reason,already_estimated,already_professional,checklist,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [space.id,space.accessToken,space.prospectId,space.city||null,space.address||null,space.propertyType||null,space.horizon||null,space.surface||null,space.rooms||null,space.dpe||null,space.terrain||null,JSON.stringify(space.ownerData),space.expectedPrice||null,space.saleReason||null,space.alreadyEstimated,space.alreadyProfessional,JSON.stringify(space.checklist),space.createdAt,space.updatedAt]
    );
  }else memory.sellerSpaces.set(space.accessToken,space);
  return space;
}

function sellerSpacePublic(row){
  if(!row) return null;
  return {
    id:row.id, accessToken:row.access_token||row.accessToken, prospectId:row.prospect_id||row.prospectId||null,
    city:row.city||"", address:row.address||"", propertyType:row.property_type||row.propertyType||"",
    horizon:row.horizon||"unknown", surface:row.surface||"", rooms:row.rooms||"", dpe:row.dpe||"", terrain:row.terrain||"", ownerData:Array.isArray(row.owner_data)?row.owner_data:[], expectedPrice:row.expected_price||"", saleReason:row.sale_reason||"", alreadyEstimated:row.already_estimated, alreadyProfessional:row.already_professional,
    checklist:Array.isArray(row.checklist)?row.checklist:[], createdAt:row.created_at||row.createdAt, updatedAt:row.updated_at||row.updatedAt
  };
}

app.post("/api/seller-access", async (req,res)=>{
  const email=cleanEmail(req.body?.email);
  if(!validEmail(email)) return apiError(res,400,"JML-A001","Adresse e-mail invalide.");
  const generic={ok:true,message:"Si un espace vendeur correspond à cette adresse, un lien d’accès vient d’être envoyé."};
  try{
    if(!pool) return res.json(generic);
    const q=await db(
      `SELECT ss.*, p.name AS prospect_name, p.email AS prospect_email
       FROM jml_seller_spaces ss
       LEFT JOIN jml_prospects p ON p.id=ss.prospect_id
       WHERE LOWER(COALESCE(p.email,''))=LOWER($1)
       ORDER BY ss.updated_at DESC NULLS LAST, ss.created_at DESC NULLS LAST
       LIMIT 1`,
      [email]
    );
    if(!q.rowCount) return res.json(generic);
    const row=q.rows[0];
    const sellerSpaceUrl=(process.env.PUBLIC_APP_URL||((req.secure||String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim()==="https")?"https":"http")+"://"+req.get("host"))+"/espace-vendeur/"+encodeURIComponent(row.access_token);
    const lead={name:row.prospect_name||"Bonjour",email:email};
    try{
      const sent=await sendLeadConfirmationEmail(lead,sellerSpaceUrl);
      if(sent?.sent) return res.json(generic);
      console.warn("JML seller access email not sent:",sent?.reason||"unknown");
    }catch(emailErr){
      console.error("JML seller access email failed:",emailErr);
    }
    return res.json(generic);
  }catch(e){
    console.error("JML seller access lookup failed:",e);
    return res.json(generic);
  }
});

app.get("/api/seller-space/:token", async (req,res)=>{
  const token=clean(req.params.token,100);
  if(!token) return apiError(res,400,"JML-S001","Accès vendeur invalide.");
  try{
    if(pool){
      const q=await db("SELECT * FROM jml_seller_spaces WHERE access_token=$1 LIMIT 1",[token]);
      if(!q.rowCount) return apiError(res,404,"JML-S002","Espace vendeur introuvable.");
      return res.json({ok:true,space:sellerSpacePublic(q.rows[0])});
    }
    const space=memory.sellerSpaces.get(token);
    if(!space) return apiError(res,404,"JML-S002","Espace vendeur introuvable.");
    return res.json({ok:true,space:sellerSpacePublic(space)});
  }catch(e){return unexpected(res,"JML-S003","Lecture de votre espace vendeur indisponible.",e);}
});

app.patch("/api/seller-space/:token", async (req,res)=>{
  const token=clean(req.params.token,100), b=req.body||{};
  const fields={city:clean(b.city,100),address:clean(b.address,180),propertyType:clean(b.propertyType,60),horizon:clean(b.horizon,20),surface:clean(b.surface,40),rooms:clean(b.rooms,40),dpe:clean(b.dpe,10),terrain:clean(b.terrain,40),ownerData:Array.isArray(b.ownerData)?b.ownerData.slice(0,10).map(o=>({firstName:clean(o?.firstName,80),lastName:clean(o?.lastName,80),phone:clean(o?.phone,40),email:cleanEmail(o?.email)})):[],expectedPrice:clean(b.expectedPrice,30),saleReason:clean(b.saleReason,1000),alreadyEstimated:b.alreadyEstimated===true||b.alreadyEstimated==="Oui"?true:b.alreadyEstimated===false||b.alreadyEstimated==="Non"?false:null,alreadyProfessional:b.alreadyProfessional===true||b.alreadyProfessional==="Oui"?true:b.alreadyProfessional===false||b.alreadyProfessional==="Non"?false:null};
  const checklist=Array.isArray(b.checklist)?b.checklist.map(x=>Number(x)).filter(x=>Number.isInteger(x)&&x>=1&&x<=6).slice(0,6):null;
  try{
    if(pool){
      const q=await db(`UPDATE jml_seller_spaces SET city=$2,address=$3,property_type=$4,horizon=$5,surface=$6,rooms=$7,
        dpe=COALESCE(NULLIF($8,''),dpe),terrain=$9,owner_data=$10::jsonb,expected_price=$11,sale_reason=$12,already_estimated=$13,already_professional=$14,
        checklist=COALESCE($15::jsonb,checklist),updated_at=NOW() WHERE access_token=$1 RETURNING *`,
        [token,fields.city||null,fields.address||null,fields.propertyType||null,fields.horizon||"unknown",fields.surface||null,fields.rooms||null,fields.dpe||null,fields.terrain||null,JSON.stringify(fields.ownerData),fields.expectedPrice||null,fields.saleReason||null,fields.alreadyEstimated,fields.alreadyProfessional,checklist?JSON.stringify(checklist):null]);
      if(!q.rowCount) return apiError(res,404,"JML-S004","Espace vendeur introuvable.");
      return res.json({ok:true,space:sellerSpacePublic(q.rows[0])});
    }
    const space=memory.sellerSpaces.get(token);
    if(!space) return apiError(res,404,"JML-S004","Espace vendeur introuvable.");
    Object.assign(space,{...fields,dpe:fields.dpe||space.dpe||"",ownerData:fields.ownerData,expectedPrice:fields.expectedPrice,saleReason:fields.saleReason,alreadyEstimated:fields.alreadyEstimated,alreadyProfessional:fields.alreadyProfessional}); if(checklist) space.checklist=checklist; space.updatedAt=now(); memory.sellerSpaces.set(token,space);
    return res.json({ok:true,space:sellerSpacePublic(space)});
  }catch(e){return unexpected(res,"JML-S005","Mise à jour de votre espace vendeur indisponible.",e);}
});

app.post("/api/leads", async (req,res) => {
  const b=req.body||{};
  const lead={id:newId(),name:clean(b.name,120),email:clean(b.email,180),phone:clean(b.phone,40),city:clean(b.city,100),propertyType:clean(b.propertyType,60),horizon:clean(b.horizon,20),source:clean(b.source||"Lead Magnet",80),consent:toBoolean(b.consent),createdAt:now()};
  if(!lead.name) return apiError(res,400,"JML-L003","Nom requis.");
  if(!lead.email&&!lead.phone) return apiError(res,400,"JML-L004","Email ou téléphone requis.");
  if(!validEmail(lead.email)) return apiError(res,400,"JML-L005","Email invalide.");
  if(!lead.consent) return apiError(res,400,"JML-L006","Consentement requis.");
  try{
    if(pool){
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO jml_leads (id,name,email,phone,city,property_type,horizon,source,consent,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [lead.id,lead.name,lead.email||null,lead.phone||null,lead.city||null,lead.propertyType||null,lead.horizon||null,lead.source,true,lead.createdAt]
        );

        // Une demande explicite devient immédiatement un prospect exploitable.
        // Si le contact existe déjà, on réutilise la fiche au lieu de créer un doublon.
        let existing=null;
        if(lead.phone||lead.email){
          const dup=await client.query(
            `SELECT * FROM jml_prospects
             WHERE (phone IS NOT NULL AND phone <> '' AND phone=$1)
                OR (email IS NOT NULL AND email <> '' AND LOWER(email)=LOWER($2))
             ORDER BY created_at ASC LIMIT 1`,
            [lead.phone||null,lead.email||null]
          );
          if(dup.rowCount) existing=dup.rows[0];
        }

        let prospectId=existing?.id||newId();
        if(!existing){
          const p=normalizeProspect({
            name:lead.name,
            city:lead.city,
            phone:lead.phone,
            email:lead.email,
            property_type:lead.propertyType||"Maison",
            horizon:lead.horizon||"unknown",
            source:lead.source||"Lead Magnet",
            status:"À qualifier",
            contact_basis:"Contact demandé par la personne",
            contact_consent:true,
            notes:"Demande captée via formulaire JML. Recontact autorisé."
          });
          p.id=prospectId;
          const q=scoreProspect(p);
          const nextAt=p.horizon==="0-3" ? new Date(Date.now()+24*3600*1000)
            : p.horizon==="3-6" ? new Date(Date.now()+3*24*3600*1000) : null;
          await client.query(
            `INSERT INTO jml_prospects
             (id,name,city,phone,email,property_type,horizon,source,status,contact_basis,contact_consent,consent_at,notes,score,priority,reasons,next_action,next_action_at,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [p.id,p.name,p.city||null,p.phone||null,p.email||null,p.property_type,p.horizon,p.source,p.status,p.contact_basis,true,lead.createdAt,p.notes||null,q.score,q.priority,JSON.stringify(q.reasons),q.nextAction,nextAt,lead.createdAt,lead.createdAt]
          );
        }

        // Le prospect et son espace vendeur doivent être créés dans la même
        // transaction : si l'un échoue, rien n'est validé partiellement.
        const existingSpaceResult=await client.query(
          "SELECT * FROM jml_seller_spaces WHERE prospect_id=$1 ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST LIMIT 1",
          [prospectId]
        );
        const sellerSpace=existingSpaceResult.rowCount
          ? sellerSpacePublic(existingSpaceResult.rows[0])
          : await createSellerSpace(
              {city:lead.city,address:b.address,propertyType:lead.propertyType,horizon:lead.horizon,surface:b.surface,rooms:b.rooms,dpe:b.dpe,terrain:b.terrain},
              prospectId,
              client
            );
        await client.query("COMMIT");

        const sellerSpaceUrl=(process.env.PUBLIC_APP_URL||((req.secure||String(req.headers["x-forwarded-proto"]||"").split(",")[0].trim()==="https")?"https":"http")+"://"+req.get("host"))+"/espace-vendeur/"+sellerSpace.accessToken;
        let emailConfirmation = { sent: false, reason: "no-email" };
        try {
          emailConfirmation = await sendLeadConfirmationEmail(lead,sellerSpaceUrl);
        } catch (emailErr) {
          console.error("JML email confirmation failed:", emailErr);
          emailConfirmation = { sent: false, reason: "send-failed" };
        }
        return res.status(201).json({ok:true,persisted:true,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation,spaceToken:sellerSpace.accessToken,spaceUrl:sellerSpaceUrl});
      }catch(txErr){
        await client.query("ROLLBACK");
        throw txErr;
      }finally{
        client.release();
      }
    }

    memory.leads.set(lead.id,lead);
    const existing=[...memory.prospects.values()].find(p=>
      (lead.phone&&p.phone&&lead.phone===p.phone) ||
      (lead.email&&p.email&&lead.email.toLowerCase()===String(p.email).toLowerCase())
    );
    let prospectId=existing?.id;
    if(!existing){
      const p=normalizeProspect({
        name:lead.name,city:lead.city,phone:lead.phone,email:lead.email,
        property_type:lead.propertyType||"Maison",horizon:lead.horizon||"unknown",
        source:lead.source||"Lead Magnet",status:"À qualifier",
        contact_basis:"Contact demandé par la personne",contact_consent:true,
        notes:"Demande captée via formulaire JML. Recontact autorisé."
      });
      const q=scoreProspect(p);
      const nextAt=p.horizon==="0-3" ? new Date(Date.now()+24*3600*1000).toISOString()
        : p.horizon==="3-6" ? new Date(Date.now()+3*24*3600*1000).toISOString() : null;
      const out={...p,...q,nextActionAt:nextAt,createdAt:lead.createdAt,updatedAt:lead.createdAt};
      memory.prospects.set(p.id,out);
      prospectId=p.id;
    }
    let sellerSpace=[...memory.sellerSpaces.values()].find(s=>String(s.prospectId||"")===String(prospectId||""))||null;
    if(!sellerSpace){
      sellerSpace=await createSellerSpace({city:lead.city,address:b.address,propertyType:lead.propertyType,horizon:lead.horizon,surface:b.surface,rooms:b.rooms,dpe:b.dpe,terrain:b.terrain},prospectId);
    }
    const sellerSpaceUrl=req.protocol+"://"+req.get("host")+"/espace-vendeur/"+sellerSpace.accessToken;
    let emailConfirmation = { sent: false, reason: "no-email" };
    try {
      emailConfirmation = await sendLeadConfirmationEmail(lead,sellerSpaceUrl);
    } catch (emailErr) {
      console.error("JML email confirmation failed:", emailErr);
      emailConfirmation = { sent: false, reason: "send-failed" };
    }
    return res.status(201).json({ok:true,persisted:false,id:lead.id,prospectId,alreadyInCrm:!!existing,emailConfirmation,spaceToken:sellerSpace.accessToken,spaceUrl:sellerSpaceUrl});
  }catch(e){
    console.error("JML-L001 lead POST failed:",{
      message:String(e?.message||e),
      code:e?.code||null,
      constraint:e?.constraint||null,
      table:e?.table||null,
      column:e?.column||null
    });
    unexpected(res,"JML-L001","Enregistrement du lead indisponible.",e);
  }
});

app.get("/api/leads", async (req,res) => {
  if(!requireAdminOr401(req,res)) return;

  try{
    if(pool){const q=await db("SELECT * FROM jml_leads ORDER BY created_at DESC LIMIT 500");return res.json({ok:true,persisted:true,leads:q.rows});}
    res.json({ok:true,persisted:false,leads:[...memory.leads.values()].reverse()});
  }catch(e){res.status(503).json({ok:false,error:"Lecture des leads indisponible.",detail:e.message});}
});



function buildMandatIntelligence(prospects, activitiesByProspect = new Map()){
  const nowMs=Date.now();
  return prospects.map(p=>{
    const reasons=[];
    const daysSinceContact=p.last_contact_at ? Math.floor((nowMs-new Date(p.last_contact_at).getTime())/86400000) : null;
    if(p.horizon==="0-3") reasons.push("Projet annoncé dans les 3 mois");
    else if(p.horizon==="3-6") reasons.push("Projet annoncé dans les 3 à 6 mois");
    if(p.status==="À relancer") reasons.push("Relance déjà prévue");
    if(p.status==="RDV pris") reasons.push("Rendez-vous déjà obtenu");
    if(p.status==="Estimation") reasons.push("Étape estimation en cours");
    if(daysSinceContact !== null && daysSinceContact >= 30) reasons.push("Aucun contact depuis "+daysSinceContact+" jours");
    if(p.contact_count===0) reasons.push("Premier contact à réaliser");
    const last=(activitiesByProspect.get(p.id)||[])[0]||null;
    if(last?.outcome==="À rappeler") reasons.push("Le dernier échange demande un rappel");
    if(last?.outcome==="Intéressé") reasons.push("Intérêt vendeur confirmé lors du dernier échange");
    const baseScore=Number.isFinite(Number(p.score)) ? Number(p.score) : 0;
    let priorityBoost=0;
    if(p.horizon==="0-3") priorityBoost+=30;
    if(p.horizon==="3-6") priorityBoost+=20;
    if(last?.outcome==="À rappeler") priorityBoost+=15;
    if(p.status==="RDV pris") priorityBoost+=15;
    if(p.status==="Estimation") priorityBoost+=20;
    if(daysSinceContact>=30) priorityBoost+=10;
    const action=p.status==="RDV pris" ? "Préparer le rendez-vous"
      : p.status==="Estimation" ? "Faire le suivi de l'estimation"
      : p.horizon==="0-3" ? "Appeler et proposer un rendez-vous"
      : p.horizon==="3-6" ? "Programmer une relance datée"
      : "Qualifier le projet puis planifier la prochaine action";
    return {id:p.id,name:p.name,city:p.city||"",status:p.status,horizon:p.horizon,score:baseScore,priority:p.priority||null,
      reasons:reasons.slice(0,5),priorityBoost,nextAction:action,lastOutcome:last?.outcome||null,lastActivityAt:last?.created_at||null};
  }).filter(x=>x.status!=="Mandat"&&x.status!=="Pas de projet")
    .sort((a,b)=>((b.score||0)+(b.priorityBoost||0))-((a.score||0)+(a.priorityBoost||0))).slice(0,5);
}

app.get("/api/mandat-intelligence", async (req,res)=>{
  if(!requireAdminOr401(req,res)) return;

  try{
    let prospects=[],activities=[];
    if(pool){
      const p=await db("SELECT * FROM jml_prospects WHERE status NOT IN ('Mandat','Pas de projet') ORDER BY updated_at DESC");
      const a=await db("SELECT prospect_id,id,type,note,outcome,created_at FROM jml_activities ORDER BY created_at DESC LIMIT 1000");
      prospects=p.rows;activities=a.rows;
    }else prospects=[...memory.prospects.values()].filter(p=>p.status!=="Mandat"&&p.status!=="Pas de projet");
    const map=new Map();
    activities.forEach(a=>{if(!map.has(a.prospect_id))map.set(a.prospect_id,[]);map.get(a.prospect_id).push(a);});
    res.json({ok:true,count:prospects.length,priorities:buildMandatIntelligence(prospects,map),modules:[
      {key:"reactivation",label:"Réactivation des anciennes opportunités",prompts:[1,2,5,7]},
      {key:"rdv",label:"Préparation du rendez-vous vendeur",prompts:[9,10,12,13,15]},
      {key:"objections",label:"Traitement des objections",prompts:[23,24,25,27]},
      {key:"daily",label:"Priorités du jour",prompts:[37,39]}
    ]});
  }catch(e){unexpected(res,"JML-P015","Intelligence mandat indisponible.",e);}
});

app.get("/api/seller-advice",function(req,res){
  const city=clean(req.query.city,100);
  const isArdennes=/ardennes|charleville|sedan|rethel|revin|nouzon|givet|fumay/i.test(city||"");
  const items=[
    {category:"💡 CONSEIL VENDEUR",title:"Avant de fixer votre prix, regardez les ventes réellement comparables",text:"Un prix affiché dans une annonce ne suffit pas pour situer votre bien. Les ventes les plus utiles sont celles qui présentent des caractéristiques proches : type de bien, surface, pièces, localisation et période de vente.",takeaway:"Commencez par comparer des biens réellement proches avant de retenir un prix de mise en vente.",sourceName:"JML Immobilier — méthode de lecture des comparables",sourceUrl:"/vendeur-secteur.html",publishedAt:"Repère méthodologique"},
    {category:"⚡ DPE",title:"Le calcul du DPE évolue au 1er janvier 2027",text:"Le coefficient de conversion de l’électricité passera de 1,9 à 1,7. Certains logements chauffés à l’électricité pourront voir leur étiquette évoluer, mais ce n’est pas automatique.",takeaway:"Avant une vente, vérifiez la date et la situation exacte de votre DPE.",sourceName:"Service-Public.fr — information officielle, 01/09/2026",sourceUrl:"https://www.service-public.fr/particuliers/actualites/A18446",publishedAt:"01/09/2026"},
    {category:"📊 MARCHÉ",title:"Les repères de prix doivent être lus à la bonne échelle",text:"Les données immobilières permettent de comparer les niveaux de prix entre territoires, mais une moyenne communale ne décrit pas à elle seule un bien précis.",takeaway:"Pour votre bien, privilégiez les transactions comparables et le contexte immédiat du secteur.",sourceName:"Notaires de France — immobilier",sourceUrl:"https://www.immobilier.notaires.fr/fr/prix-immobilier",publishedAt:"Consulté le 29/09/2026"},
    {category:"🏦 CRÉDIT",title:"Le financement des acquéreurs reste un élément du marché",text:"Les conditions de crédit influencent la capacité d'achat des acquéreurs et peuvent donc intervenir dans la lecture du marché vendeur.",takeaway:"Le prix d'un bien doit être mis en regard du marché et du budget des acquéreurs.",sourceName:"CAFPI — baromètre des taux, 25/09/2026",sourceUrl:"https://www.cafpi.fr/credit-immobilier/barometre-taux/actualites-taux/analyse-taux-credit-immobilier-septembre-2026",publishedAt:"25/09/2026"}
  ];
  const filtered=isArdennes ? items : items.filter(function(x){return x.category!=="📊 MARCHÉ";});
  res.json({ok:true,city:city||null,updatedAt:"29/09/2026",items:filtered});
});

app.get("/api/publication-ideas",(_req,res)=>res.json([
  {title:"Prix réel vs prix espéré",target:"vendeurs",hook:"Votre maison vaut-elle vraiment le prix que vous avez en tête ?"},
  {title:"Travaux avant vente",target:"vendeurs",hook:"Faut-il vraiment refaire sa maison avant de la vendre ?"},
  {title:"Erreur d'estimation",target:"vendeurs",hook:"L'erreur d'estimation qui peut coûter cher à un propriétaire."},
  {title:"Marché local",target:"vendeurs",hook:"Que nous dit le marché immobilier de votre commune ?"},
  {title:"DPE",target:"vendeurs",hook:"DPE : ce qu'un propriétaire doit vérifier avant de vendre."},
  {title:"Vente dans 6 mois",target:"vendeurs",hook:"Vous pensez vendre dans quelques mois ? Commencez par ceci."}
]));

app.get("/guide",(_req,res)=>res.sendFile(path.join(__dirname,"public","guide.html")));
app.get("*",(_req,res)=>res.redirect(302,"/projet-vendeur"));

async function start(){
  // Render doit pouvoir valider le port/health check immédiatement.
  // L'initialisation PostgreSQL se fait ensuite sans bloquer le démarrage HTTP.
  app.listen(PORT,()=>console.log(`JML Projet Vendeur v${VERSION} HTTP listening on ${PORT}`));
  try{
    await initDb();
    dbReady = true;
    console.log(`JML Projet Vendeur v${VERSION} database ready`);
    setTimeout(async()=>{
      try{
        const status=pool?await db("SELECT COUNT(*)::int AS total FROM jml_dpe WHERE department_code='08'"):null;
        console.log("JML DPE 08 local:",Number(status?.rows?.[0]?.total||0),"lignes. Enrichissement ADEME direct activé.");
      }catch(error){console.warn("JML DPE 08 status différé:",error.message);}
    },5000);
  }catch(err){
    console.error("DB init failed:",err);
    console.error("JML Projet Vendeur continue en mode dégradé tant que PostgreSQL n'est pas disponible.");
  }
}
start();