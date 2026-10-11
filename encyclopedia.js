"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const DATA_PATH = path.join(__dirname, "data", "encyclopedia.json.gz.b64");
let cachedItems;
function loadItems() {
  if (cachedItems) return cachedItems;
  try {
    const encoded = fs.readFileSync(DATA_PATH, "utf8").replace(/\s+/g, "");
    const parsed = JSON.parse(zlib.gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
    if (!Array.isArray(parsed.items)) throw new Error("Catalogue invalide.");
    cachedItems = parsed.items;
    return cachedItems;
  } catch (error) {
    console.error("JML encyclopedia:", error.message);
    return [];
  }
}
function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
function searchItems({q="",category="",appliesTo="",limit=20}={}) {
  const query=normalize(q), cat=normalize(category), scope=normalize(appliesTo);
  const max=Math.max(1,Math.min(50,Number.parseInt(limit,10)||20));
  return loadItems().filter(item=>{
    if(cat && normalize(item.category)!==cat) return false;
    if(scope && scope!=="all" && scope!=="both" && normalize(item.appliesTo)!==scope && normalize(item.appliesTo)!=="both") return false;
    return !query || [item.title,item.category,item.appliesTo,item.definition,item.slug].some(v=>normalize(v).includes(query));
  }).slice(0,max);
}
module.exports=function registerEncyclopediaRoutes(app) {
  app.get("/api/encyclopedia", (req,res)=>{
    const items=loadItems();
    res.setHeader("Cache-Control","public, max-age=300");
    res.json({ok:true,count:items.length,categories:[...new Set(items.map(x=>x.category))].sort(),appliesTo:["residential","commercial","both"],notice:"Catalogue explicatif uniquement : aucune incidence sur le calcul DVF/DPE. Le fichier source ne contient ni les articles complets, ni les mots-clés eux-mêmes, ni les URL des sources.",items:searchItems({q:req.query.q,category:req.query.category,appliesTo:req.query.appliesTo,limit:req.query.limit})});
  });
  app.get("/api/encyclopedia/:slug", (req,res)=>{
    const item=loadItems().find(x=>x.slug===String(req.params.slug||""));
    if(!item) return res.status(404).json({ok:false,error:"Fiche immobilière introuvable."});
    res.setHeader("Cache-Control","public, max-age=300");
    return res.json({ok:true,item,notice:"Définition issue du catalogue fourni; texte intégral et sources détaillées absents du fichier source."});
  });
};
