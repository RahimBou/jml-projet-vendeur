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

async function fetchHtml(url, timeout=8000){
  try{
    const response=await fetch(url,{headers:DEFAULT_HEADERS,redirect:"follow",signal:AbortSignal.timeout(timeout)});
    if(!response.ok) return null;
    const html=await response.text();
    return html && html.length>200 ? {html,url:response.url||url} : null;
  }catch(_error){
    return null;
  }
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
function efficityUrl(city,postal){
  return "https://www.efficity.com/prix-immobilier-m2/v_"+slugify(city)+"_"+postal+"/";
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
  const internalCode=String(Number(code.slice(2))).padStart(3,"0");
  return "https://www.seloger.com/prix-de-l-immo/vente/"+region+"/"+department+"/"+slugify(city)+"/"+dep.replace(/^0/,"")+internalCode+".htm";
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
    automatic:true
  };
}

async function getPublicMarketBenchmarks({city,propertyType,surface,postalCode,communeCode}={}){
  const cleanCity=normalizeText(city);
  const postal=String(postalCode||"").match(/\b\d{5}\b/)?.[0]||"";
  if(!cleanCity||!/^\d{5}$/.test(postal)) return [];
  const tasks=[
    readSource("Meilleurs Agents",meilleursAgentsUrl(cleanCity,postal),propertyType,surface,(text,type)=>{
      const direct=pairForType(text,type);
      if(direct) return direct;
      const app=text.match(/Appartement[\s\S]{0,250}?Prix m2 moyen[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?de[\s:]*([\d\s\u00a0\u202f.,]+)\s*€[\s\S]{0,100}?à[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/i);
      return app?{type:"Appartement",priceM2:numberFrom(app[1]),lowM2:numberFrom(app[2]),highM2:numberFrom(app[3])}:null;
    }),
    readSource("PAP",papUrl(cleanCity,postal),propertyType,surface,(text,type)=>{
      const wanted=/appartement|studio|duplex|loft/i.test(type||"")?"appartement":"maison";
      const re=wanted==="appartement"
        ?/(?:prix\s*\/\s*m²\s*des\s*appartements|appartements?)[\s\S]{0,80}?([\d\s\u00a0\u202f.,]+)\s*€/i
        :/(?:prix\s*\/\s*m²\s*des\s*maisons|maisons?)[\s\S]{0,80}?([\d\s\u00a0\u202f.,]+)\s*€/i;
      const m=text.match(re);
      if(!m) return null;
      return {type:wanted==="appartement"?"Appartement":"Maison",priceM2:numberFrom(m[1])};
    }),
    readSource("efficity",efficityUrl(cleanCity,postal),propertyType,surface,(text,type)=>{
      const direct=pairForType(text,type);
      if(direct) return direct;
      const wanted=/appartement|studio|duplex|loft/i.test(type||"")?"appartement":"maison";
      const re=wanted==="appartement"
        ?/(?:appartements?)[\s\S]{0,120}?prix\s*m2\s*moyen[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/i
        :/(?:maisons?)[\s\S]{0,120}?prix\s*m2\s*moyen[\s:]*([\d\s\u00a0\u202f.,]+)\s*€/i;
      const m=text.match(re);
      return m?{type:wanted==="appartement"?"Appartement":"Maison",priceM2:numberFrom(m[1])}:null;
    }),
    selogerUrl(cleanCity,communeCode)
      ? readSource("SeLoger",selogerUrl(cleanCity,communeCode),propertyType,surface,(text,type)=>{
          const wanted=/appartement|studio|duplex|loft/i.test(type||"")?"appartement":"maison";
          const re=wanted==="appartement"
            ?/prix moyen des appartements au m2[\s\S]{0,100}?([\d\s\u00a0\u202f.,]+)\s*€/i
            :/prix moyen des maisons au m2[\s\S]{0,100}?([\d\s\u00a0\u202f.,]+)\s*€/i;
          const m=text.match(re);
          return m?{type:wanted==="appartement"?"Appartement":"Maison",priceM2:numberFrom(m[1])}:null;
        })
      : Promise.resolve(null)
  ];
  const results=await Promise.allSettled(tasks);
  return results.map(x=>x.status==="fulfilled"?x.value:null).filter(Boolean);
}

module.exports={getPublicMarketBenchmarks,meilleursAgentsUrl,papUrl,efficityUrl,selogerUrl};
