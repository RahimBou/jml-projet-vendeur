"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const htmlPath = "public/vendeur-secteur.html";
const html = fs.readFileSync(htmlPath, "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(source => source.trim().length > 0);
if (scripts.length === 0) {
  throw new Error("Aucun JavaScript intégré trouvé dans " + htmlPath);
}
const temporaryPath = "/tmp/jml-vendeur-inline.js";
fs.writeFileSync(temporaryPath, scripts.join("\n;\n"), "utf8");
const result = spawnSync(process.execPath, ["--check", temporaryPath], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log("Syntaxe JavaScript intégrée vérifiée :", scripts.length, "bloc(s).");
