const { URL } = require("url");

function clean(v,max=160){
  return String(v==null?"":v).replace(/\s+/g," ").trim().slice(0,max);
}
function num(v){
  if(v==null) return null;
  const s=String(v).replace(/\u00a0/g," ").replace(/[^0-9,\.]/g,"").replace(/\.(?=.*\.)/g,"");
  if(!s) return null;
  const n=Number(s.replace(",","."));
  return Number.isFinite(n)?n:null;
}
function moneyFromText(text){
  const m=String(text||"").match(/(?:prix|prix de vente|vente)?[^€]{0,80}([0-9]{2,3}(?:[ .\u00a0][0-9]{3})+(?:,[0-9]+)?)\s*€/i)
    || String(text||"").match(/\b([0-9]{2,3}(?:[ .\u00a0][0-9]{3})+)\s*€/);
  return m?num(m[1]):null;
}
function surfaceFromText(text){
  const m=String(text||"").match(/\b([0-9]{2,4}(?:[.,][0-9]+)?)\s*m(?:²|2)\b/i);
  return m?num(m[1]):null;
}
function roomsFromText(text){
  const m=String(text||"").match(/\b([1-9][0-9]?)\s*(?:pièces?|p\.?\s*pieces?)\b/i);
  return m?Math.round(num(m[1])):null;
}
function terrainFromText(text){
  const m=String(text||"").match(/\b([0-9]{2,5}(?:[ .\u00a0][0-9]{3})?)\s*m(?:²|2)\s*(?:de\s*)?terrain\b/i);
  return m?num(m[1]):null;
}
function normalizeUrl(raw){
  try{
    const u=new URL(raw);
    if(!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  }catch(_){ return null; }
}
async function fetchText(url,timeoutMs=12000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{
      signal:controller.signal,
      headers:{
        "user-agent":"Mozilla/5.0 (compatible; JML-Projet-Vendeur/1.0; +https://jml-immobilier.fr/)",
        "accept":"text/html,application/xhtml+xml"
      }
    });
    if(!r.ok) return "";
    return await r.text();
  }catch(_){ return "";}
  finally{ clearTimeout(timer); }
}
function stripHtml(html){
  return String(html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&euro;/gi,"€")
    .replace(/&#39;/gi,"'")
    .replace(/&quot;/gi,'"')
    .replace(/\s+/g," ").trim();
}
function searchResultBlocks(html){
  const out=[];
  const source=String(html||"");
  const re=/<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while((m=re.exec(source))){
    const block=m[1];
    const a=block.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if(!a) continue;
    const url=normalizeUrl(a[1]);
    if(!url) continue;
    const title=stripHtml(a[2]);
    const snippetMatch=block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet=stripHtml(snippetMatch?.[1]||block);
    out.push({url,title,snippet});
  }
  return out;
}
async function bingSearch(query){
  const url="https://www.bing.com/search?q="+encodeURIComponent(query)+"&count=10&setlang=fr-fr&cc=fr";
  const html=await fetchText(url,15000);
  return searchResultBlocks(html);
}
function isListingHost(host){
  return /(seloger\.com|bienici\.com|pap\.fr|leboncoin\.fr|logic-immo\.com|paruvendu\.fr)$/i.test(host);
}
function inferType(text){
  if(/\b(appartement|studio|duplex|loft|penthouse)\b/i.test(text)) return "appartement";
  if(/\b(maison|pavillon|villa|demeure)\b/i.test(text)) return "maison";
  return null;
}
function scoreListing(item,input){
  const blob=(item.title+" "+item.snippet+" "+item.pageText).toLowerCase();
  let score=0;
  const wantedHouse=!/appartement|studio|duplex|loft/i.test(input.propertyType||"");
  const type=inferType(blob);
  if(type===(wantedHouse?"maison":"appartement")) score+=35;
  else if(type) score-=35;
  const city=clean(input.city,80).toLowerCase();
  if(city && blob.includes(city)) score+=15;
  const postal=String(input.postalCode||"");
  if(postal && blob.includes(postal)) score+=20;
  const area=Number(input.surface);
  if(Number.isFinite(area)&&area>0&&item.surface){
    const ratio=item.surface/area;
    if(ratio>=0.85&&ratio<=1.15) score+=25;
    else if(ratio>=0.70&&ratio<=1.30) score+=15;
    else if(ratio>=0.55&&ratio<=1.45) score+=5;
    else score-=15;
  }
  const rooms=Number(input.rooms);
  if(Number.isFinite(rooms)&&rooms>0&&item.rooms!=null){
    const d=Math.abs(item.rooms-rooms);
    score+=d===0?15:d===1?8:d===2?2:-8;
  }
  const terrain=Number(input.terrain);
  if(Number.isFinite(terrain)&&terrain>0&&item.terrain){
    const ratio=item.terrain/terrain;
    if(ratio>=0.65&&ratio<=1.50) score+=10;
    else if(ratio>=0.40&&ratio<=2.20) score+=4;
  }
  if(item.priceM2){
    if(item.priceM2>500&&item.priceM2<10000) score+=5;
    else score-=10;
  }
  return score;
}
function parseListing(r){
  const text=(r.title+" "+r.snippet).replace(/\s+/g," ").trim();
  const price=moneyFromText(text);
  const surface=surfaceFromText(text);
  const rooms=roomsFromText(text);
  const terrain=terrainFromText(text);
  const type=inferType(text);
  const priceM2=price&&surface?Math.round(price/surface):null;
  return {...r,price,surface,rooms,terrain,type,priceM2};
}
async function enrichListing(item){
  if(item.price&&item.surface) return item;
  const html=await fetchText(item.url,10000);
  if(!html) return item;
  const pageText=stripHtml(html).slice(0,50000);
  const price=item.price||moneyFromText(pageText);
  const surface=item.surface||surfaceFromText(pageText);
  const rooms=item.rooms||roomsFromText(pageText);
  const terrain=item.terrain||terrainFromText(pageText);
  return {...item,pageText,price,surface,rooms,terrain,
    type:item.type||inferType(pageText),
    priceM2:price&&surface?Math.round(price/surface):item.priceM2||null};
}
async function collectComparableListings(input={}){
  const city=clean(input.city,80);
  if(!city) return {status:"no_city",listings:[],searchedAt:new Date().toISOString()};
  const postal=String(input.postalCode||"").match(/\b\d{5}\b/)?.[0]||"";
  const house=!/appartement|studio|duplex|loft/i.test(input.propertyType||"");
  const type=house?"maison":"appartement";
  const rooms=Number(input.rooms);
  const surface=Number(input.surface);
  const pieces=Number.isFinite(rooms)&&rooms>0?String(Math.round(rooms))+" pièces":"";
  const area=Number.isFinite(surface)&&surface>0?String(Math.round(surface))+" m²":"";
  const location=postal?city+" "+postal:city;
  const queries=[
    'site:seloger.com/annonce/achat '+type+' '+location+' '+pieces+' '+area,
    'site:bienici.com/annonce '+type+' '+location+' '+pieces+' '+area,
    'site:pap.fr/annonce '+type+' '+location+' '+pieces+' '+area,
    'site:logic-immo.com '+type+' '+location+' '+pieces+' '+area
  ];
  const all=[];
  for(const q of queries){
    const rows=await bingSearch(q);
    all.push(...rows);
  }
  const seen=new Set();
  let candidates=all.filter(x=>{
    const u=x.url.toLowerCase();
    if(seen.has(u)||!isListingHost(new URL(x.url).hostname)||!isDirectListingUrl(x.url)) return false;
    seen.add(u); return true;
  }).map(parseListing);
  const enriched=[];
  for(const c of candidates.slice(0,24)){
    const e=await enrichListing(c);
    if(e.price&&e.surface) enriched.push(e);
  }
  const scored=enriched.map(x=>({...x,score:scoreListing(x,input)}))
    .filter(x=>x.score>=45&&x.priceM2)
    .sort((a,b)=>b.score-a.score||Math.abs((a.priceM2||0)-(b.priceM2||0)));
  const unique=[];
  const seen2=new Set();
  for(const x of scored){
    const key=x.url.replace(/[?#].*$/,"");
    if(seen2.has(key)) continue;
    seen2.add(key);
    unique.push({
      title:clean(x.title,180),url:x.url,source:new URL(x.url).hostname.replace(/^www\./,""),
      price:Math.round(x.price),surface:Number(x.surface),rooms:x.rooms,terrain:x.terrain||null,
      priceM2:Math.round(x.priceM2),score:Math.max(0,Math.min(100,Math.round(x.score))),
      type:x.type||type
    });
    if(unique.length>=10) break;
  }
  const m2=unique.map(x=>x.priceM2).filter(Number.isFinite).sort((a,b)=>a-b);
  const median=m2.length?(m2.length%2?m2[(m2.length-1)/2]:(m2[m2.length/2-1]+m2[m2.length/2])/2):null;
  const weighted=unique.length?Math.round(unique.reduce((s,x)=>s+x.priceM2*x.score,0)/unique.reduce((s,x)=>s+x.score,0)):null;
  const estimatedValue=weighted&&Number.isFinite(surface)&&surface>0?Math.round(weighted*surface):null;
  return {
    status:"completed",searchedAt:new Date().toISOString(),queryCount:queries.length,
    comparableCount:unique.length,medianPriceM2:median,weightedPriceM2:weighted,
    estimatedValue,city,postalCode:postal,type,area:surface||null,rooms:rooms||null,listings:unique
  };
}
module.exports={collectComparableListings};
