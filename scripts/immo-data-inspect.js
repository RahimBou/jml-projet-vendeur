#!/usr/bin/env node
"use strict";

/**
 * Inspection sans écriture de la base : découvre les outils Immo Data
 * disponibles via MCP avant de construire l'importateur de transactions.
 */
const MCP_URL = String(process.env.IMMO_DATA_MCP_URL || "https://mcp.immo-data.fr/mcp").trim();
const API_KEY = String(process.env.IMMO_DATA_API_KEY || "").trim();

if (!API_KEY) {
  console.error("IMMO_DATA_API_KEY manquante. Aucune clé n'est affichée ni enregistrée.");
  process.exit(2);
}

async function rpc(method, params = {}, id = 1) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + API_KEY,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("MCP HTTP " + response.status + " — " + body.slice(0, 500));
  }
  const dataLines = body.split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  const candidates = dataLines.length ? dataLines : [body];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.error) throw new Error("MCP " + JSON.stringify(parsed.error));
      if (parsed.result) return parsed.result;
    } catch (error) {
      if (String(error.message || "").startsWith("MCP ")) throw error;
    }
  }
  throw new Error("Réponse MCP non reconnue (contenu masqué pour éviter toute fuite de clé).");
}

async function main() {
  const result = await rpc("tools/list", {}, 1);
  const tools = Array.isArray(result.tools) ? result.tools : [];
  if (!tools.length) throw new Error("Aucun outil MCP reçu.");
  const selected = tools.filter(tool =>
    /search_transactions|geocode|get_geo_area/i.test(String(tool.name || ""))
  );
  console.log("Connexion MCP Immo Data : OK");
  console.log("Outils exposés :", tools.length);
  console.log(JSON.stringify(selected.map(tool => ({
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema || {}
  })), null, 2));
  if (!selected.some(tool => /search_transactions/i.test(String(tool.name || ""))) ) {
    console.error("ATTENTION : l'outil search_transactions n'est pas exposé par cette clé.");
    process.exitCode = 3;
  }
  console.log("Aucune transaction interrogée. Aucune donnée écrite en base.");
}

main().catch(error => {
  console.error("Inspection Immo Data échouée :", String(error.message || error));
  process.exitCode = 1;
});
