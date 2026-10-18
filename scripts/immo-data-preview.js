#!/usr/bin/env node
"use strict";

// Une seule page de test Immo Data, sans écriture en base.
// Coût annoncé par Immo Data : 0,01 € par page.
const MCP_URL = String(process.env.IMMO_DATA_MCP_URL || "https://mcp.immo-data.fr/mcp").trim();
const API_KEY = String(process.env.IMMO_DATA_API_KEY || "").trim();
const SIZE = Math.min(5, Math.max(1, Number(process.env.IMMO_DATA_PREVIEW_SIZE || 5)));

if (!API_KEY) {
  console.error("IMMO_DATA_API_KEY manquante.");
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
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error("MCP HTTP " + response.status + ": " + body.slice(0, 300));
  const data = body.split(/\r?\n/).filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim()).filter(Boolean);
  for (const candidate of (data.length ? data : [body]).reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.error) throw new Error("MCP " + JSON.stringify(parsed.error));
      if (parsed.result) return parsed.result;
    } catch (error) {
      if (String(error.message || "").startsWith("MCP ")) throw error;
    }
  }
  throw new Error("Réponse MCP non reconnue.");
}

function unwrap(result) {
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.text) {
        try { return JSON.parse(item.text); } catch (_) {}
      }
    }
  }
  return result;
}

async function main() {
  const args = {
    code: "08105",
    geoLevel: "city",
    dateMin: "2020-01-01",
    dateMax: new Date().toISOString().slice(0, 10),
    txType: ["sales"],
    realtyType: ["house", "apartment"],
    sortBy: "date",
    sortOrder: "desc",
    size: SIZE
  };
  const result = unwrap(await rpc("tools/call", {
    name: "search_transactions",
    arguments: args
  }));
  if (result?.isError) throw new Error("Immo Data a signalé une erreur : " + JSON.stringify(result).slice(0, 800));

  function summarize(value, depth = 0) {
    if (depth > 3 || value == null) return value;
    if (Array.isArray(value)) {
      return { type: "array", length: value.length, sample: value.length ? summarize(value[0], depth + 1) : null };
    }
    if (typeof value === "object") {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (/address|street|owner|name|phone|email/i.test(key)) out[key] = item == null ? null : "[masqué dans l'aperçu]";
        else out[key] = summarize(item, depth + 1);
      }
      return out;
    }
    if (typeof value === "string" && value.length > 180) return value.slice(0, 180) + "…";
    return value;
  }

  console.log("Aperçu Immo Data — 1 seule page, aucune écriture en base.");
  console.log("Paramètres :", JSON.stringify({ ...args, dateMax: args.dateMax }));
  console.log(JSON.stringify(summarize(result), null, 2));
  console.log("Terminé. Aucun import ni modification PostgreSQL.");
}

main().catch(error => {
  console.error("Aperçu Immo Data échoué :", String(error.message || error));
  process.exitCode = 1;
});
