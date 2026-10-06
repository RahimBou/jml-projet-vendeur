"use strict";

process.env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH||"0";
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const { getPublicMarketBenchmarks } = require("./external-estimators");

let chromiumReady=false;
function ensureChromium(){
  if(chromiumReady) return;
  try{
    const exe=chromium.executablePath();
    const fs=require("fs");
    if(!exe || !fs.existsSync(exe)){
      execFileSync(process.platform==="win32"?"npx.cmd":"npx",["playwright","install","chromium","chromium-headless-shell"],{stdio:"inherit",timeout:600000,env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||"0"}});
    }
    chromiumReady=true;
  }catch(error){
    throw new Error("Chromium Playwright indisponible: "+String(error?.message||error));
  }
}

const ALLOWED_SITES = {
  meilleursagents: {
    name: "Meilleurs Agents",
    host: /(^|\\.)meilleursagents\\.com$/i,
    url: "https://www.meilleursagents.com/estimation-immobiliere/"
  },
  seloger: {
    name: "SeLoger",
    host: /(^|\\.)seloger\\.com$/i,
    url: "https://www.seloger.com/estimation-immobiliere.html"
  },
  pap: {
    name: "PAP",
    host: /(^|\\.)pap\\.fr$/i,
    url: "https://www.pap.fr/vendeur/estimation-gratuite"
  },
  efficity: {
    name: "efficity",
    host: /(^|\\.)efficity\\.com$/i,
    url: "https://www.efficity.com/estimation-immobiliere/"
  },
  orpi: {
    name: "Orpi",
    host: /(^|\\.)orpi\\.com$/i,
    url: "https://www.orpi.com/prix-immobilier/"
  },
  bienici: {
    name: "Bien'ici",
    host: /(^|\\.)bienici\\.com$/i,
    url: "https://www.bienici.com/estimation"
  },
  century21: {
    name: "CENTURY 21",
    host: /(^|\\.)century21\\.fr$/i,
    url: "https://www.century21.fr/estimation-immobiliere"
  },
  laforet: {
    name: "Laforêt",
    host: /(^|\\.)laforet\\.com$/i,
    url: "https://www.laforet.com/estimer"
  },
  squarehabitat: {
    name: "Square Habitat",
    host: /(^|\\.)squarehabitat\\.fr$/i,
    url: "https://www.squarehabitat.fr/estimation"
  }
};

function moneyValues(text){
  const out=[];
  const re=/(\\d{2,3}(?:[ .\\u00a0]\\d{3})+|\\d{5,7})(?:[.,]\\d+)?\\s*€?/g;
  for(const m of String(text||"").matchAll(re)){
    const n=Number(String(m[1]).replace(/[ .\\u00a0]/g,"").replace(",","."));
    if(Number.isFinite(n)&&n>=30000&&n<=5000000) out.push(Math.round(n));
  }
  return [...new Set(out)];
}


function extractEstimateFromCandidates(values,text){
  const t=String(text||"").replace(/\s+/g," ");
  if(!values.length) return null;
  const keywords=/(estimation|estimé|estimée|valeur|prix de votre bien|prix du bien|votre bien vaut|fourchette|fourchette de prix)/i;
  const nearby=[];
  for(const v of values){
    const s=String(v);
    const pos=t.indexOf(s.replace(/\B(?=(\d{3})+(?!\d))/g," "));
    if(pos>=0 && keywords.test(t.slice(Math.max(0,pos-220),Math.min(t.length,pos+220)))) nearby.push(v);
  }
  const nums=[...new Set(nearby)].filter(n=>n>=30000&&n<=5000000);
  if(nums.length===1) return {value:nums[0],low:null,high:null};
  if(nums.length>=2) return {value:Math.round((Math.min(...nums)+Math.max(...nums))/2),low:Math.min(...nums),high:Math.max(...nums)};
  return null;
}

function extractEstimate(text){
  const t=String(text||"").replace(/\\s+/g," ");
  const patterns=[
    /(?:estimation|valeur estimée|prix estimé|valeur du bien|prix de votre bien)[^€]{0,180}?([\\d .\\u00a0]{5,12})\\s*€/i,
    /(?:entre|de)[^€]{0,40}?([\\d .\\u00a0]{5,12})\\s*€[^€]{0,80}?(?:et|à)[^€]{0,30}?([\\d .\\u00a0]{5,12})\\s*€/i,
    /([\\d .\\u00a0]{5,12})\\s*€[^€]{0,80}?(?:estimation|valeur estimée|prix estimé)/i
  ];
  for(const re of patterns){
    const m=t.match(re); if(!m) continue;
    const nums=m.slice(1).map(x=>Number(String(x).replace(/[ .\\u00a0]/g,""))).filter(n=>Number.isFinite(n)&&n>=30000&&n<=5000000);
    if(nums.length===1) return {value:Math.round(nums[0]),low:null,high:null};
    if(nums.length>=2) return {value:Math.round((nums[0]+nums[1])/2),low:Math.min(...nums),high:Math.max(...nums)};
  }
  return null;
}

async function firstLocator(page, candidates){
  for(const selector of candidates){
    const loc=page.locator(selector).first();
    try{
      if(await loc.count() && await loc.isVisible({timeout:700})) return loc;
    }catch(_){}
  }
  return null;
}

async function fillSmart(page, labels, value){
  if(value===undefined||value===null||String(value).trim()==="") return false;
  const v=String(value).trim();
  const selectors=[];
  for(const label of labels){
    selectors.push(
      `input[placeholder*="${label}" i]`,
      `input[name*="${label}" i]`,
      `input[id*="${label}" i]`,
      `textarea[placeholder*="${label}" i]`,
      `select[name*="${label}" i]`,
      `select[id*="${label}" i]`
    );
  }
  const loc=await firstLocator(page,selectors);
  if(!loc) return false;
  try{
    const tag=await loc.evaluate(el=>el.tagName.toLowerCase());
    if(tag==="select") await loc.selectOption({label:v}).catch(()=>loc.selectOption(v));
    else await loc.fill(v);
    return true;
  }catch(_){ return false; }
}

async function acceptCookies(page){
  const buttons=page.getByRole("button",{name:/accepter|tout accepter|j'accepte|autoriser/i});
  try{ if(await buttons.count()) await buttons.first().click({timeout:1200}); }catch(_){}
}

async function detectCaptcha(page){
  const body=(await page.locator("body").innerText().catch(()=>"" )).toLowerCase();
  return /captcha|recaptcha|hcaptcha|je ne suis pas un robot/.test(body);
}


async function clickText(page, patterns){
  for(const pattern of patterns){
    const loc=page.getByText(pattern,{exact:false}).first();
    try{
      if(await loc.count() && await loc.isVisible({timeout:700})){
        await loc.click({timeout:2500});
        return true;
      }
    }catch(_){}
  }
  return false;
}

async function prepareSiteForm(page,id,input){
  const addressFull=[input.address,input.postalCode,input.city].filter(Boolean).join(", ");
  if(id==="pap"){
    await fillSmart(page,["adresse du bien","adresse","address","rue"],addressFull||input.address);
    await page.waitForTimeout(900);
    const suggestions=page.locator('[role="option"], li, [class*="suggest"], [class*="autocomplete"]');
    try{
      const count=await suggestions.count();
      for(let i=0;i<Math.min(count,8);i++){
        const s=suggestions.nth(i);
        const txt=(await s.innerText().catch(()=>"" )).trim();
        if(txt && ((input.city&&txt.toLowerCase().includes(String(input.city).toLowerCase())) ||
                   (input.postalCode&&txt.includes(String(input.postalCode))) ||
                   (input.address&&txt.toLowerCase().includes(String(input.address).toLowerCase())))){
          await s.click({timeout:1800}).catch(()=>{});
          break;
        }
      }
    }catch(_){}
    if(/maison/i.test(String(input.propertyType||""))){
      await clickText(page,[/^Maison$/i,"Maison"]);
    }else{
      await clickText(page,[/^Appartement$/i,"Appartement"]);
    }
    await fillSmart(page,["surface du bien","surface","m²","m2"],input.surface);
    await fillSmart(page,["pièces","pieces","rooms"],input.rooms);
    await fillSmart(page,["année","construction"],input.year);
    return;
  }

  if(id==="meilleursagents"){
    await fillSmart(page,["adresse du bien","adresse","address","rue"],addressFull||input.address);
    await page.waitForTimeout(900);
    await page.keyboard.press("ArrowDown").catch(()=>{});
    await page.keyboard.press("Enter").catch(()=>{});
    await page.waitForTimeout(700);
    await fillSmart(page,["code postal","postal","zip"],input.postalCode);
    await fillSmart(page,["ville","city","commune"],input.city);
    return;
  }

  if(id==="seloger"){
    await fillSmart(page,["adresse du bien","adresse","address","rue"],addressFull||input.address);
    await page.waitForTimeout(900);
    await page.keyboard.press("ArrowDown").catch(()=>{});
    await page.keyboard.press("Enter").catch(()=>{});
    await page.waitForTimeout(500);
    await fillSmart(page,["surface","m²","m2"],input.surface);
    await fillSmart(page,["pièces","pieces","rooms"],input.rooms);
    await fillSmart(page,["type de bien","type","property type"],input.propertyType);
    return;
  }

  await fillSmart(page,["adresse","address","rue"],input.address);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter").catch(()=>{});
  await fillSmart(page,["ville","city","commune"],input.city);
  await fillSmart(page,["code postal","postal","zip"],input.postalCode);
  await fillSmart(page,["surface","m²","m2"],input.surface);
  await fillSmart(page,["pièces","pieces","rooms"],input.rooms);
  await fillSmart(page,["type de bien","type","property type"],input.propertyType);
  await fillSmart(page,["terrain","surface du terrain"],input.terrain);
  await fillSmart(page,["dpe","diagnostic"],input.dpe);
}

async function waitForResult(page,timeout=8000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    if(await detectCaptcha(page)) return false;
    const text=(await page.locator("body").innerText().catch(()=>"" )).slice(0,30000);
    if(/(?:estimation|valeur estimée|prix estimé|votre bien|fourchette de prix|€)/i.test(text)){
      const values=moneyValues(text);
      if(values.length) return true;
    }
    await page.waitForTimeout(500);
  }
  return true;
}

function extractEstimateFromJson(value){
  const candidates=[];
  const walk=(v,path="")=>{
    if(v==null) return;
    if(typeof v==="number" && Number.isFinite(v) && v>=30000 && v<=5000000){ candidates.push({value:Math.round(v),path}); return; }
    if(typeof v==="string"){ for(const n of moneyValues(v)) candidates.push({value:n,path}); return; }
    if(typeof v==="object") for(const [k,x] of Object.entries(v).slice(0,250)) walk(x,path?path+"."+k:k);
  };
  walk(value);
  const preferred=candidates.filter(x=>/(estimate|estimation|valuation|value|price|prix|amount|montant|minimum|maximum|median|range|fourchette)/i.test(x.path));
  const pool=preferred.length?preferred:candidates;
  const uniq=[...new Map(pool.map(x=>[x.value,x])).values()];
  if(!uniq.length) return null;
  if(uniq.length===1) return {value:uniq[0].value,low:null,high:null,source:"network"};
  const nums=uniq.map(x=>x.value), low=Math.min(...nums), high=Math.max(...nums);
  if(high-low>0 && high/low<4) return {value:Math.round((low+high)/2),low,high,source:"network"};
  return {value:uniq[0].value,low:null,high:null,source:"network"};
}


async function fillLabel(page,labels,value){
  if(value===undefined||value===null||String(value).trim()==="") return false;
  for(const label of labels){
    try{
      const loc=page.getByLabel(new RegExp(label,"i")).first();
      if(await loc.count() && await loc.isVisible({timeout:700})){ await loc.fill(String(value)); return true; }
    }catch(_){}
  }
  return fillSmart(page,labels,value);
}

async function clickButtonText(page,names){
  for(const name of names){
    const loc=page.getByRole("button",{name:new RegExp(name,"i")}).first();
    try{
      if(await loc.count() && await loc.isVisible({timeout:700})){ await loc.click({timeout:2500}); return true; }
    }catch(_){}
  }
  return false;
}

async function chooseOption(page,names){
  for(const name of names){
    try{
      const loc=page.getByRole("radio",{name:new RegExp(name,"i")}).first();
      if(await loc.count() && await loc.isVisible({timeout:700})){ await loc.check().catch(()=>loc.click()); return true; }
    }catch(_){}
    if(await clickText(page,[new RegExp("^"+name+"$","i"),name])) return true;
  }
  return false;
}

async function runPAPAdapter(page,input){
  const full=[input.address,input.postalCode,input.city].filter(Boolean).join(", ");
  const okAddress=await fillLabel(page,["Adresse du bien","Adresse"],full);
  if(!okAddress) return {status:"form_not_found",reason:"Champ adresse PAP introuvable"};
  await page.waitForTimeout(1000);
  const options=page.locator('[role="option"],li,[class*="autocomplete"],[class*="suggest"]');
  const count=await options.count().catch(()=>0);
  for(let i=0;i<Math.min(count,12);i++){
    const o=options.nth(i), txt=(await o.innerText().catch(()=>"")).trim().toLowerCase();
    if(txt && ((input.city&&txt.includes(String(input.city).toLowerCase()))||(input.postalCode&&txt.includes(String(input.postalCode))))){
      await o.click({timeout:2000}).catch(()=>{}); break;
    }
  }
  await chooseOption(page,[/maison/i.test(String(input.propertyType||""))?"Maison":"Appartement"]);
  await fillLabel(page,["Surface du bien","Surface"],input.surface);
  await fillLabel(page,["Nombre de pièces","Pièces","pieces"],input.rooms);
  await fillLabel(page,["Terrain","Surface du terrain"],input.terrain);
  return {status:"form_filled"};
}

async function runSeLogerAdapter(page,input){
  const full=[input.address,input.postalCode,input.city].filter(Boolean).join(", ");
  const okAddress=await fillLabel(page,["Adresse","Adresse du bien","address"],full);
  if(!okAddress) return {status:"form_not_found",reason:"Champ adresse SeLoger introuvable"};
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown").catch(()=>{});
  await page.keyboard.press("Enter").catch(()=>{});
  await fillLabel(page,["Code postal","Postal"],input.postalCode);
  await fillLabel(page,["Ville","Commune","City"],input.city);
  await chooseOption(page,[/maison/i.test(String(input.propertyType||""))?"Maison":"Appartement"]);
  await fillLabel(page,["Surface","Surface Carrez"],input.surface);
  await fillLabel(page,["Nombre de pièces","Pièces","pieces"],input.rooms);
  await fillLabel(page,["Année de construction","Année","Construction"],input.year);
  await fillLabel(page,["DPE","Diagnostic"],input.dpe);
  return {status:"form_filled"};
}

async function runMeilleursAgentsAdapter(page,input){
  const full=[input.address,input.postalCode,input.city].filter(Boolean).join(", ");
  const okAddress=await fillLabel(page,["Adresse","Adresse du bien"],full);
  if(!okAddress) return {status:"form_not_found",reason:"Champ adresse Meilleurs Agents introuvable"};
  await page.waitForTimeout(900);
  await page.keyboard.press("ArrowDown").catch(()=>{});
  await page.keyboard.press("Enter").catch(()=>{});
  await fillLabel(page,["Code postal","Postal"],input.postalCode);
  await fillLabel(page,["Ville","Commune"],input.city);
  await chooseOption(page,[/maison/i.test(String(input.propertyType||""))?"Maison":"Appartement"]);
  await fillLabel(page,["Surface","Surface Carrez"],input.surface);
  await fillLabel(page,["Nombre de pièces","Pièces","pieces"],input.rooms);
  await fillLabel(page,["Surface du terrain","Terrain"],input.terrain);
  await fillLabel(page,["DPE","Diagnostic"],input.dpe);
  return {status:"form_filled"};
}

async function runSpecificAdapter(page,id,input){
  if(id==="pap") return runPAPAdapter(page,input);
  if(id==="seloger") return runSeLogerAdapter(page,input);
  if(id==="meilleursagents") return runMeilleursAgentsAdapter(page,input);
  return {status:"generic"};
}

async function runEstimatorAgent(input={}){
  const requested=Array.isArray(input.sites)&&input.sites.length
    ? input.sites
    : Object.keys(ALLOWED_SITES);

  // Priorité aux repères publics réellement accessibles : cela évite de dépendre
  // du rendu navigateur quand une page communale publique donne déjà un prix/m².
  let publicSources=[];
  try{
    publicSources=await getPublicMarketBenchmarks({
      city:input.city,
      address:input.address,
      propertyType:input.propertyType,
      surface:input.surface,
      postalCode:input.postalCode,
      rooms:input.rooms,
      dpe:input.dpe,
      terrain:input.terrain
    });
  }catch(_error){ publicSources=[]; }
  const publicByName=new Map((publicSources||[]).map(x=>[String(x.name||"").toLowerCase(),x]));

  const publicIds=new Set((publicSources||[]).map(x=>String(x.name||"").toLowerCase()));
  const missingRequested=requested.filter(id=>{
    const site=ALLOWED_SITES[id];
    return site && !publicIds.has(String(site.name||"").toLowerCase());
  });

  // Si les repères publics suffisent, ne lançons même pas Chromium.
  // Cela rend l'agent rapide et évite les échecs Playwright inutiles.
  if(!missingRequested.length){
    return {
      ok:true,
      results:requested.map(id=>{
        const site=ALLOWED_SITES[id];
        const match=publicSources.find(x=>String(x.name||"").toLowerCase()===String(site?.name||"").toLowerCase());
        return match ? {
          id,name:site.name,status:"value_found",
          value:Math.round(Number(match.value)),
          low:Number.isFinite(Number(match.low))?Math.round(Number(match.low)):null,
          high:Number.isFinite(Number(match.high))?Math.round(Number(match.high)):null,
          source:"public_market",url:match.url||site.url,
          publicBenchmark:true,level:match.level||"commune",
          note:match.note||"Repère public indicatif."
        } : {id,status:"unsupported"};
      })
    };
  }

  ensureChromium();
  const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]});
  try{
    const runOne=async(id)=>{
      const site=ALLOWED_SITES[id];
      if(!site) return {id,status:"unsupported"};
      const started=Date.now();

      const publicMatch=publicByName.get(String(site.name||"").toLowerCase());
      if(publicMatch && Number.isFinite(Number(publicMatch.value)) && Number(publicMatch.value)>0){
        return {
          id,name:site.name,status:"value_found",
          value:Math.round(Number(publicMatch.value)),
          low:Number.isFinite(Number(publicMatch.low))?Math.round(Number(publicMatch.low)):null,
          high:Number.isFinite(Number(publicMatch.high))?Math.round(Number(publicMatch.high)):null,
          source:"public_market",
          url:publicMatch.url||site.url,
          elapsedMs:Date.now()-started,
          publicBenchmark:true,
          level:publicMatch.level||"commune",
          note:publicMatch.note||"Repère public indicatif."
        };
      }
      const context=await browser.newContext({locale:"fr-FR",userAgent:"JML-Projet-Vendeur/4.1"});
      const page=await context.newPage();
      const networkEstimates=[];
      page.on("response",async response=>{
        try{
          const ct=(response.headers()["content-type"]||"").toLowerCase();
          if(!ct.includes("json")) return;
          const url=response.url();
          if(!/(estimate|estimat|valuation|price|prix|property|bien|market)/i.test(url)) return;
          const data=await response.json().catch(()=>null);
          const est=extractEstimateFromJson(data);
          if(est) networkEstimates.push({...est,url});
        }catch(_){ }
      });
      try{
        await page.goto(site.url,{waitUntil:"commit",timeout:60000});
        await page.waitForLoadState("domcontentloaded",{timeout:20000}).catch(()=>{});
        await acceptCookies(page);
        if(await detectCaptcha(page)){
          return {id,name:site.name,status:"manual_required",reason:"CAPTCHA détecté",url:page.url(),elapsedMs:Date.now()-started};
        }

        const adapter=await runSpecificAdapter(page,id,input);
        if(adapter.status==="form_not_found"){
          return {id,name:site.name,status:adapter.status,reason:adapter.reason,url:page.url(),elapsedMs:Date.now()-started};
        }
        if(adapter.status==="generic") await prepareSiteForm(page,id,input);

        for(let step=0;step<4;step++){
          const next=await firstLocator(page,[
            'button:has-text("Suivant")',
            'button:has-text("Continuer")',
            'button:has-text("Poursuivre")',
            'button:has-text("Valider")'
          ]);
          const submit=await firstLocator(page,[
            'button:has-text("Estimer")',
            'button:has-text("Obtenir")',
            'button:has-text("Calculer")',
            'button:has-text("Voir mon estimation")',
            'button[type="submit"]',
            'input[type="submit"]'
          ]);
          if(submit){
            await submit.click({timeout:2500}).catch(()=>{});
            break;
          }
          if(!next) break;
          await next.click({timeout:2500}).catch(()=>{});
          await page.waitForTimeout(800);
          if(await detectCaptcha(page)) break;
        }

        await waitForResult(page,8000);
        await page.waitForTimeout(1200);
        if(await detectCaptcha(page)){
          return {id,name:site.name,status:"manual_required",reason:"CAPTCHA après soumission",url:page.url(),elapsedMs:Date.now()-started};
        }

        const text=(await page.locator("body").innerText().catch(()=>"" )).slice(0,30000);
        const values=moneyValues(text);
        const domEstimate=extractEstimate(text) || extractEstimateFromCandidates(values,text);
        const networkEstimate=networkEstimates.length ? networkEstimates[networkEstimates.length-1] : null;
        const estimate=networkEstimate || domEstimate;
        return {
          id,name:site.name,
          status:estimate?"value_found":values.length?"candidates_found":"no_value",
          value:estimate?.value||null,low:estimate?.low||null,high:estimate?.high||null,
          source:estimate?.source||"dom",
          values,url:page.url(),elapsedMs:Date.now()-started,
          networkHits:networkEstimates.length,
          excerpt:text.replace(/\\s+/g," ").slice(0,1200)
        };
      }catch(error){
        return {id,name:site.name,status:"error",error:String(error?.message||error),url:page.url(),elapsedMs:Date.now()-started};
      }finally{
        await context.close().catch(()=>{});
      }
    };
    const results=await Promise.all(requested.map(id=>runOne(id)));
    return {ok:true,results};
  }finally{
    await browser.close().catch(()=>{});
  }
}

module.exports={runEstimatorAgent,ALLOWED_SITES};
