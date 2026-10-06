"use strict";

process.env.PLAYWRIGHT_BROWSERS_PATH=process.env.PLAYWRIGHT_BROWSERS_PATH||"0";
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");

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

async function runEstimatorAgent(input={}){
  const requested=Array.isArray(input.sites)&&input.sites.length
    ? input.sites
    : Object.keys(ALLOWED_SITES);
  ensureChromium();
  const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]});
  try{
    const runOne=async(id)=>{
      const site=ALLOWED_SITES[id];
      if(!site) return {id,status:"unsupported"};
      const started=Date.now();
      const context=await browser.newContext({locale:"fr-FR",userAgent:"JML-Projet-Vendeur/4.1"});
      const page=await context.newPage();
      try{
        await page.goto(site.url,{waitUntil:"commit",timeout:60000});
        await page.waitForLoadState("domcontentloaded",{timeout:20000}).catch(()=>{});
        await acceptCookies(page);
        if(await detectCaptcha(page)){
          return {id,name:site.name,status:"manual_required",reason:"CAPTCHA détecté",url:page.url(),elapsedMs:Date.now()-started};
        }

        await prepareSiteForm(page,id,input);

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
        const estimate=extractEstimate(text) || extractEstimateFromCandidates(values,text);
        return {
          id,name:site.name,
          status:estimate?"value_found":values.length?"candidates_found":"no_value",
          value:estimate?.value||null,low:estimate?.low||null,high:estimate?.high||null,
          values,url:page.url(),elapsedMs:Date.now()-started,
          excerpt:text.replace(/\\s+/g," ").slice(0,1200)
        };
      }catch(error){
        return {id,name:site.name,status:"error",error:String(error?.message||error),url:page.url(),elapsedMs:Date.now()-started};
      }finally{
        await context.close().catch(()=>{});
      }
    };
    const results=[];
    for(const id of requested){ results.push(await runOne(id)); }
    return {ok:true,results};
  }finally{
    await browser.close().catch(()=>{});
  }
}

module.exports={runEstimatorAgent,ALLOWED_SITES};
