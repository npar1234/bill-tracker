// Household sync & backup — stores the full app state as a blob keyed by a
// SHA-256 hash of the household passphrase (server never sees the passphrase).
// Client merges on read (per-record newest-wins + tombstones), so this endpoint
// stays dumb: GET returns the blob, POST overwrites it.

const { getStore } = require("@netlify/blobs");

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1_000_000; // ~1MB is years of household bill data

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };

  const store = getStore("household-sync");

  if (event.httpMethod === "GET") {
    const h = (event.queryStringParameters || {}).household || "";
    if (!HASH_RE.test(h)) return { statusCode: 400, headers, body: '{"error":"bad household key"}' };
    try {
      const data = await store.get("hh_" + h, { type: "json" });
      return { statusCode: 200, headers, body: JSON.stringify(data || {}) };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod === "POST") {
    if ((event.body || "").length > MAX_BYTES) {
      return { statusCode: 413, headers, body: '{"error":"payload too large"}' };
    }
    try {
      const { household, state } = JSON.parse(event.body);
      if (!HASH_RE.test(household || "")) return { statusCode: 400, headers, body: '{"error":"bad household key"}' };
      if (!state || typeof state !== "object" || !Array.isArray(state.bills)) {
        return { statusCode: 400, headers, body: '{"error":"bad state"}' };
      }
      await store.setJSON("hh_" + household, { state, savedAt: Date.now() });
      return { statusCode: 200, headers, body: '{"ok":true}' };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers, body: '{"error":"method not allowed"}' };
};
