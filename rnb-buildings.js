"use strict";

// Client RNB — recherche par adresse BAN ou proximité géographique.
// Ne renvoie que les propriétés utiles au rapprochement ; aucun propriétaire n'est identifié.
const BASE="https://rnb-api.beta.gouv.fr/api/alpha/buildings/";
const DEFAULT_HEADERS={
  "Accept":"application/json",
  "User-Agent":"JML-Projet-Vendeur/3.14.2 (RNB building matching)"
};
const cache=new Map();
const TTL=30*60*1000;

function cleanText(value,max=240){
  return String(value||"").replace(/[<>\u0000-\u001f\u007f]/g," ").trim().slice(0,max);
}
function mapBuilding(item,distance=null){
  const addresses=Array.isArray(item?.addresses)?item.addresses.map(a=>({
    number:cleanText(a?.street_number,20),
    repetition:cleanText(a?.street_rep,10),
    street:cleanText(a?.street,120),
    city:cleanText(a?.city_name,100),
    postalCode:cleanText(a?.city_zipcode,10),
    communeCode:cleanText(a?.city_insee_code,10),
    source:cleanText(a?.source,80),
    banId:cleanText(a?.ban_id,80)
  })): [];
  const coordinates=Array.isArray(item?.point?.coordinates)?item.point.coordinates.map(Number):[];
  return {
    rnbId:cleanText(item?.rnb_id,80),
    status:cleanText(item?.status,30),
    active:item?.is_active===true,
    point:coordinates.length>=2&&coordinates.slice(0,2).every(Number.isFinite)?{lon:coordinates[0],lat:coordinates[1]}:null,
    geometryType:cleanText(item?.shape?.type,20)||null,
    addresses,
    externalIds:Array.isArray(item?.ext_ids)?item.ext_ids.slice(0,10).map(x=>({id:cleanText(x?.id,100),source:cleanText(x?.source,40)})):[],
    distanceMeters:Number.isFinite(Number(distance))?Number(distance):null
  };
}
async function getJson(url){
  const cached=cache.get(url);
  if(cached&&cached.expires>Date.now()) return cached.data;
  const response=await fetch(url,{headers:DEFAULT_HEADERS,redirect:"follow",signal:AbortSignal.timeout(8000)});
  if(response.status===429){
    const e=new Error("Quota RNB atteint");e.statusCode=429;e.code="RNB_RATE_LIMIT";throw e;
  }
  if(!response.ok){
    const e=new Error("RNB HTTP "+response.status);e.statusCode=response.status;e.code="RNB_HTTP_ERROR";throw e;
  }
  const data=await response.json();
  cache.set(url,{data,expires:Date.now()+TTL});
  if(cache.size>500){for(const [key,value] of cache){if(value.expires<=Date.now())cache.delete(key);} }
  return data;
}
async function searchRnbBuildings({address,lat,lon,radius=500}={}){
  let url,mode;
  if(address){
    const q=cleanText(address,240);
    if(q.length<5) throw Object.assign(new Error("Adresse trop courte pour une recherche fiable."),{code:"ADDRESS_TOO_SHORT",statusCode:400});
    url=BASE+"address/?q="+encodeURIComponent(q);
    mode="address";
  }else{
    if(!Number.isFinite(Number(lat))||!Number.isFinite(Number(lon))) throw Object.assign(new Error("Coordonnées invalides."),{code:"INVALID_COORDINATES",statusCode:400});
    const r=Math.max(0,Math.min(1000,Number(radius)||500));
    url=BASE+"closest/?point="+encodeURIComponent(Number(lat)+","+Number(lon))+"&radius="+encodeURIComponent(r);
    mode="proximity";
  }
  const payload=await getJson(url);
  const raw=Array.isArray(payload?.results)?payload.results:[];
  const results=raw.slice(0,100).map(x=>mapBuilding(x,x?.distance)).filter(x=>x.rnbId);
  return {
    mode,
    status:cleanText(payload?.status,60)||"ok",
    geocodingScore:Number.isFinite(Number(payload?.score_ban))?Number(payload.score_ban):null,
    addressKey:cleanText(payload?.cle_interop_ban,120)||null,
    count:results.length,
    next:typeof payload?.next==="string"?payload.next:null,
    results,
    sourceUrl:url,
    limitation:mode==="address"
      ?"Une adresse peut correspondre à plusieurs bâtiments. Vérifier les candidats avant de choisir un identifiant RNB."
      :"Recherche limitée au rayon demandé (maximum 1 000 m). Le résultat le plus proche n'est pas automatiquement le bon bâtiment."
  };
}
module.exports={searchRnbBuildings};
