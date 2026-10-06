const DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml",
  "User-Agent": "JML-Projet-Vendeur/4.0 (public-market-benchmark)"
};

function normalizeText(value){
  return String(value || "")
    .replace(/\u00a0|\u202f/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value){
  return normalizeText(value)
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase()
    .replace(/['’]/g,"-")
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"");
}

function numberFrom(value){
  const raw=normalizeText(value).replace(/\s/g,"").replace(",",".").replace(/[^\d.-]/g,"");
  const n=Number(raw);
  return Number.isFinite(n)&&n>0?n:null;
}

const geoRegistryEstimateCache=new Map();

function normalizeStreetKey(value){
  return normalizeText(String(value||""))
    .replace(/^\\d+[a-z]?\\s*/i,"")
    .replace(/\\b(av|avenue|bd|boulevard|chem|chemin|rte|route|pl|place|imp|impasse|all|allee|allée|rue|faubourg|fg)\\b/g," ")
    .replace(/[^a-z0-9]+/g," ")
    .trim()
    .replace(/\\s+/g," ");
}
function medianNumber(values){
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function quartileNumber(values,q){
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if(!a.length) return null;
  const pos=(a.length-1)*q, lo=Math.floor(pos), hi=Math.ceil(pos);
  return lo===hi?a[lo]:a[lo]+(a[hi]-a[lo])*(pos-lo);
}
async function getGeoRegistryStreetEstimate({address,city,postalCode,propertyType,surface}={}){
  const area=Number(surface);
  if(!address || !Number.isFinite(area) || area<=0) return null;
  const type_local=/appartement|studio|duplex|loft/i.test(propertyType||"") ? 2 : 1;
  const fullAddress=[String(address||"").trim(),String(postalCode||"").trim(),String(city||"").trim()].filter(Boolean).join(", ");
  const streetKey=normalizeStreetKey(address);
  try{
    const url="https://georegistry.fr/api/v1/dvf/ventes/address?adresse="+encodeURIComponent(fullAddress)+"&radius=1000&limit=100&type_local="+type_local;
    const response=await fetch(url,{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/4.1 (external-estimator)"},
      signal:AbortSignal.timeout(9000)
    });
    if(!response.ok) return null;
    const payload=await response.json();
    const sales=Array.isArray(payload?.data)?payload.data:[];
    const valid=sales.map(x=>{
      const price=Number(x?.valeur_fonciere), m2=Number(x?.prix_m2), built=Number(x?.surface_bati);
      return {
        street:normalizeStreetKey(x?.adresse),
        price,
        m2:Number.isFinite(m2)&&m2>0?m2:(Number.isFinite(price)&&price>0&&Number.isFinite(built)&&built>0?price/built:null),
        distance:Number(x?.distance_m)
      };
    }).filter(x=>x.street===streetKey&&Number.isFinite(x.m2)&&x.m2>0);
    if(!valid.length) return null;
    const m2s=valid.map(x=>x.m2);
    const median=medianNumber(m2s);
    if(!Number.isFinite(median)||median<=0) return null;
    const lowM2=quartileNumber(m2s,.25), highM2=quartileNumber(m2s,.75);
    const data={
      id:"georegistry_street",
      name:"GeoRegistry — rue",
      level:"address",
      priceM2:Math.round(median),
      lowM2:Number.isFinite(lowM2)?Math.round(lowM2):null,
      highM2:Number.isFinite(highM2)?Math.round(highM2):null,
      value:Math.round(median*area),
      low:Number.isFinite(lowM2)?Math.round(lowM2*area):null,
      high:Number.isFinite(highM2)?Math.round(highM2*area):null,
      url:"https://georegistry.fr/estimation",
      note:"Repère automatique calculé à partir des ventes DVF GeoRegistry retrouvées sur la même rue ; ce n'est pas une estimation commerciale.",
      quality:"street_dvf",
      personalized:true,
      automatic:true,
      confidence:valid.length>=5?"high":valid.length>=3?"medium":"low",
      comparablesCount:valid.length
    };
    return data;
  }catch(_error){
    return null;
  }
}

async function getGeoRegistryEstimate({address,city,postalCode,propertyType,surface,rooms,dpe,condition,terrain}={}) {
  const area=Number(surface);
  const cacheKey=[address,city,postalCode,propertyType,surface,rooms,dpe,condition,terrain].map(normalizeText).join("|");
  const cached=geoRegistryEstimateCache.get(cacheKey);
  if(cached&&cached.expiresAt>Date.now()) return {...cached.data,cache:true};
  if(!address || !Number.isFinite(area) || area<=0) return null;
  const type_local=/appartement|studio|duplex|loft/i.test(propertyType||"") ? 2 : 1;
  const fullAddress=[String(address||"").trim(),String(postalCode||"").trim(),String(city||"").trim()].filter(Boolean).join(", ");
  try{
    const response=await fetch("https://georegistry.fr/api/v1/dvf/estimate",{
      method:"POST",
      headers:{
        "Accept":"application/json",
        "Content-Type":"application/json",
        "User-Agent":"JML-Projet-Vendeur/4.1 (external-estimator)"
      },
      body:JSON.stringify({
        type_local,
        surface_bati:Math.round(area),
        adresse:fullAddress
      }),
      signal:AbortSignal.timeout(9000)
    });
    if(response.ok){
      const payload=await response.json();
      const result=payload?.data;
      const estimate=Number(result?.estimate);
      const priceM2=Number(result?.price_per_m2);
      if(Number.isFinite(estimate)&&estimate>0&&Number.isFinite(priceM2)&&priceM2>0){
        const low=Number(result?.range?.low), high=Number(result?.range?.high);
        const confidence=result?.confidence?String(result.confidence):null;
        const comparablesCount=Number(result?.comparables_count);
        const data={
          id:"georegistry",name:"GeoRegistry",level:"address",
          priceM2:Math.round(priceM2),
          lowM2:Number.isFinite(low)&&low>0?Math.round(low/area):null,
          highM2:Number.isFinite(high)&&high>0?Math.round(high/area):null,
          value:Math.round(estimate),
          low:Number.isFinite(low)&&low>0?Math.round(low):null,
          high:Number.isFinite(high)&&high>0?Math.round(high):null,
          url:"https://georegistry.fr/estimation",
          note:"Estimation automatique à l'adresse par comparables DVF ; fourchette et confiance fournies par le moteur.",
          quality:"address_estimate",personalized:true,automatic:true,confidence,
          comparablesCount:Number.isFinite(comparablesCount)?comparablesCount:null
        };
        geoRegistryEstimateCache.set(cacheKey,{expiresAt:Date.now()+30*60*1000,data});
        return data;
      }
    }
    const street=await getGeoRegistryStreetEstimate({address,city,postalCode,propertyType,surface});
    if(street){
      geoRegistryEstimateCache.set(cacheKey,{expiresAt:Date.now()+30*60*1000,data:street});
      return street;
    }
    return null;
  }catch(_error){
    const street=await getGeoRegistryStreetEstimate({address,city,postalCode,propertyType,surface});
    if(street){
      geoRegistryEstimateCache.set(cacheKey,{expiresAt:Date.now()+30*60*1000,data:street});
      return street;
    }
    return null;
  }
}

async function fetchHtml(url, timeout=8000){
  try{
    const response=await fetch(url,{headers:DEFAULT_HEADERS,redirect:"follow",signal:AbortSignal.timeout(timeout)});
    if(response.ok){
      const html=await response.text();
      if(html && html.length>200) return {html,url:response.url||url,readerUsed:false};
    }
  }catch(_error){}
  try{
    const response=await fetch("https://r.jina.ai/"+url,{
      headers:{"Accept":"text/plain","User-Agent":"JML-Projet-Vendeur/4.1"},
      redirect:"follow",
      signal:AbortSignal.timeout(15000)
    });
    if(response.ok){
      const html=await response.text();
      if(html && html.length>100) return {html,url,readerUsed:true};
    }
  }catch(_error){}
  return null;
}

function htmlText(html){
  return normalizeText(String(html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&euro;/gi," € ")
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&amp;/gi,"&"));
}

function pairForType(text,type){
  const wanted=/appartement|studio|duplex|loft/i.test(type||"") ? "appartement" : "maison";
  const patterns = wanted==="appartement" ? [
    /appartements?(?:\s+à)?[\s\S]{0,180}?prix\s*(?:m2|m²)\s*(?:moyen)?[\s\S]{0,80}?([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,120}?(?:prix bas|bas)[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,120}?(?:prix haut|haut)[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/m/i,
    /prix\s*(?:m2|m²)\s*(?:moyen)?[\s\S]{0,60}?([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?prix bas[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?prix haut[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/m/i,
    /appartements?[^0-9]{0,180}([\d\s\u00a0\u202f.,]+)\s*€\s*\/\s*m²/i
  ] : [
    /maisons?(?:\s+à)?[\s\S]{0,180}?prix\s*(?:m2|m²)\s*(?:moyen)?[\s\S]{0,80}?([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,120}?(?:prix bas|bas)[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,120}?(?:prix haut|haut)[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/m/i,
    /prix\s*(?:m2|m²)\s*(?:moyen)?[\s\S]{0,60}?([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?prix bas[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?prix haut[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/m/i,
    /maisons?[^0-9]{0,180}([\d\s\u00a0\u202f.,]+)\s*€\s*\/\s*m²/i
  ];
  for(const re of patterns){
    const m=String(text||"").match(re);
    if(!m) continue;
    const priceM2=numberFrom(m[1]);
    if(!priceM2) continue;
    return {type:wanted==="appartement"?"Appartement":"Maison",priceM2,lowM2:numberFrom(m[2]),highM2:numberFrom(m[3])};
  }
  return null;
}

function meilleursAgentsUrl(city,postal){
  return "https://www.meilleursagents.com/prix-immobilier/"+slugify(city)+"-"+postal+"/";
}
function papUrl(city,postal){
  return "https://www.pap.fr/vendeur/prix-m2/"+slugify(city)+"-"+postal;
}
function papSaleUrl(city,postal){
  return "https://www.pap.fr/annonce/vente-immobiliere-"+slugify(city)+"-"+postal;
}
function papDepartmentUrl(communeCode,postalCode){
  const dep=String(communeCode||"").slice(0,2) || String(postalCode||"").slice(0,2);
  return dep==="08" ? "https://www.pap.fr/vendeur/prix-m2/ardennes-08-g371" : null;
}

function findPapCityUrl(html,city,postal){
  const wantedSlug=slugify(city);
  const wantedPostal=String(postal||"").trim();
  if(!wantedSlug||!/^[0-9]{5}$/.test(wantedPostal)) return null;
  const source=String(html||"");
  const re=/<a[^>]+href=["']([^"']*\/vendeur\/prix-m2\/[^"']+)["'][^>]*>/gi;
  for(const m of source.matchAll(re)){
    let href=String(m[1]||"").replace(/&amp;/g,"&");
    try{
      const absolute=new URL(href,"https://www.pap.fr").href;
      const path=new URL(absolute).pathname.toLowerCase();
      if(path.includes("/vendeur/prix-m2/") && path.includes(wantedSlug) && path.includes(wantedPostal)) return absolute;
    }catch(_){}
  }
  return null;
}
function efficityUrl(city,postal){
  return "https://www.efficity.com/prix-immobilier-m2/v_"+slugify(city)+"_"+postal+"/";
}
function orpiUrl(city){
  return "https://www.orpi.com/prix-immobilier/"+slugify(city);
}
function selogerRegionForDepartment(departmentCode){
  const code=String(departmentCode||"").padStart(2,"0");
  const map={
    "08":"champagne-ardenne","10":"champagne-ardenne","51":"champagne-ardenne","52":"champagne-ardenne",
    "67":"alsace","68":"alsace","54":"lorraine","55":"lorraine","57":"lorraine","88":"lorraine",
    "59":"nord-pas-de-calais","62":"nord-pas-de-calais","75":"ile-de-france"
  };
  return map[code]||null;
}
function selogerDepartmentName(departmentCode){
  const map={"08":"ardennes","10":"aube","51":"marne","52":"haute-marne","67":"bas-rhin","68":"haut-rhin","54":"meurthe-et-moselle","55":"meuse","57":"moselle","88":"vosges"};
  return map[String(departmentCode||"").padStart(2,"0")]||null;
}
function selogerUrl(city,communeCode){
  const code=String(communeCode||"").trim();
  if(!/^\d{5}$/.test(code)) return null;
  const dep=code.slice(0,2);
  const region=selogerRegionForDepartment(dep), department=selogerDepartmentName(dep);
  if(!region||!department) return null;
  const internalCode=String(Number(code.slice(2))).padStart(4,"0");
  return "https://www.seloger.com/prix-de-l-immo/vente/"+region+"/"+department+"/"+slugify(city)+"/"+dep.replace(/^0/,"")+internalCode+".htm";
}

async function resolveCommuneCode(city,postalCode){
  try{
    const qs=new URLSearchParams({nom:String(city||""),codePostal:String(postalCode||""),fields:"code,nom,codesPostaux",format:"json"});
    const r=await fetch("https://geo.api.gouv.fr/communes?"+qs.toString(),{
      headers:{"Accept":"application/json","User-Agent":"JML-Projet-Vendeur/4.1"},
      signal:AbortSignal.timeout(6000)
    });
    if(!r.ok) return "";
    const rows=await r.json();
    const wanted=String(postalCode||"");
    const exact=(Array.isArray(rows)?rows:[]).find(x=>Array.isArray(x.codesPostaux)&&x.codesPostaux.includes(wanted));
    return String((exact||rows?.[0])?.code||"").match(/^\d{5}$/)?.[0]||"";
  }catch(_){ return ""; }
}

async function readSource(name,url,propertyType,surface,parser){
  const page=await fetchHtml(url);
  if(!page) return null;
  const text=htmlText(page.html);
  const parsed=parser(text,propertyType);
  if(!parsed) return null;
  const value=Number.isFinite(Number(surface))&&Number(surface)>0 ? Math.round(parsed.priceM2*Number(surface)) : null;
  return {
    id:name.toLowerCase().replace(/[^a-z0-9]+/g,"-"),
    name,
    level:"commune",
    priceM2:parsed.priceM2,
    lowM2:parsed.lowM2||null,
    highM2:parsed.highM2||null,
    value,
    low:Number.isFinite(Number(surface))&&Number(surface)>0&&parsed.lowM2?Math.round(parsed.lowM2*Number(surface)):null,
    high:Number.isFinite(Number(surface))&&Number(surface)>0&&parsed.highM2?Math.round(parsed.highM2*Number(surface)):null,
    url:page.url||url,
    note:"Repère public au m² de la commune ; ce n'est pas une saisie personnalisée dans le formulaire d'estimation.",
    level:"commune",
    quality:"benchmark",
    personalized:false,
    automatic:true
  };
}

async function getPublicMarketBenchmarks({city,address,propertyType,surface,postalCode,communeCode,rooms,dpe,condition,terrain}={}){
  const cleanCity=normalizeText(city);
  const postal=String(postalCode||"").match(/\b\d{5}\b/)?.[0]||"";
  const area=Number(surface);
  if(!cleanCity||!/^[0-9]{5}$/.test(postal)) return [];
  const resolvedCommuneCode=String(communeCode||"").match(/^\d{5}$/)?.[0] || await resolveCommuneCode(cleanCity,postal);
  const wantedHouse=!/appartement|studio|duplex|loft/i.test(propertyType||"");
  function parsePap(text){
    const t=htmlText(text);
    const exactHouse=t.match(/prix\s*\/\s*m²\s*des\s*maisons\s*([\d\s\u00a0\u202f.,]+)\s*€/i);
    if(wantedHouse && exactHouse){ const priceM2=numberFrom(exactHouse[1]); if(priceM2) return {type:"Maison",priceM2}; }
    const exactApartment=t.match(/prix\s*\/\s*m²\s*des\s*appartements\s*([\d\s\u00a0\u202f.,]+)\s*€/i);
    if(!wantedHouse && exactApartment){ const priceM2=numberFrom(exactApartment[1]); if(priceM2) return {type:"Appartement",priceM2}; }
    const faq=wantedHouse
      ? t.match(/prix\s+(?:au|du)\s*m[²2]\s+[^.]{0,220}?maison[^\d]{0,100}([\d\s\u00a0\u202f.,]+)\s*euros?/i)
      : t.match(/prix\s+(?:au|du)\s*m[²2]\s+[^.]{0,220}?appartement[^\d]{0,100}([\d\s\u00a0\u202f.,]+)\s*euros?/i);
    if(faq){ const priceM2=numberFrom(faq[1]); if(priceM2) return {type:wantedHouse?"Maison":"Appartement",priceM2}; }
    // Sur la page département PAP, la ville apparaît dans le tableau
    // sous la forme "Ville (CP) appartement € maison €". Cela permet
    // de récupérer le repère communal même lorsque PAP refuse l'URL
    // courte ou que la page communale est protégée.
    const cityPos=t.toLowerCase().indexOf(cleanCity.toLowerCase());
    if(cityPos>=0){
      const row=t.slice(cityPos,cityPos+700);
      const nums=[...row.matchAll(/([\d\s\u00a0\u202f.,]+)\s*€/g)]
        .map(m=>numberFrom(m[1])).filter(Boolean);
      // Pour une maison, PAP affiche appartement puis maison.
      // Pour un appartement, le premier prix est celui des appartements.
      const priceM2=wantedHouse?nums[1]:nums[0];
      if(priceM2) return {type:wantedHouse?"Maison":"Appartement",priceM2};
    }
    return null;
  }
  const directUrl=papUrl(cleanCity,postal);
  const depUrl=papDepartmentUrl(resolvedCommuneCode,postal);

  async function buildResult(page,fallbackUrl){
    if(!page) return null;
    const parsed=parsePap(page.html);
    if(!parsed) return null;
    return {id:"pap",name:"PAP",level:"commune",priceM2:parsed.priceM2,
      value:Number.isFinite(area)&&area>0?Math.round(parsed.priceM2*area):null,
      lowM2:null,highM2:null,low:null,high:null,url:page.url||fallbackUrl,
      note:"Prix public PAP au m² de la commune, utilisé comme repère de marché.",
      quality:"pap_public",personalized:false,automatic:true};
  }

  // PAP ajoute un suffixe technique à certaines pages de communes (ex. -g9256).
  // On commence donc par l'URL courte, puis on résout l'URL canonique depuis la page du département.
  const directPage=await fetchHtml(directUrl,10000);
  const directResult=await buildResult(directPage,directUrl);
  if(directResult) return [directResult];

  if(depUrl){
    const depPage=await fetchHtml(depUrl,10000);
    const depResult=await buildResult(depPage,depUrl);
    if(depResult) return [depResult];

    const canonical=findPapCityUrl(depPage?.html,cleanCity,postal);
    if(canonical && canonical!==directUrl){
      const cityPage=await fetchHtml(canonical,10000);
      const cityResult=await buildResult(cityPage,canonical);
      if(cityResult) return [cityResult];
    }
  }

  return [];
}
module.exports={getPublicMarketBenchmarks,meilleursAgentsUrl,papUrl,efficityUrl,selogerUrl};
