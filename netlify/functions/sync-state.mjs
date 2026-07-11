// Household sync & backup — stores the full app state as a blob keyed by a
// SHA-256 hash of the household passphrase (server never sees the passphrase).
// Client merges on read (per-record newest-wins + tombstones), so this endpoint
// stays dumb: GET returns the blob, POST overwrites it.
// Functions v2 format — Netlify Blobs auto-configures here (CJS handlers don't).

import { getStore } from "@netlify/blobs";

const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_BYTES = 1_000_000; // ~1MB is years of household bill data

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  // Strong consistency: a device pulling right after the other one pushed sees the fresh blob
  const store = getStore({ name: "household-sync", consistency: "strong" });

  if (req.method === "GET") {
    const h = new URL(req.url).searchParams.get("household") || "";
    if (!HASH_RE.test(h)) return Response.json({ error: "bad household key" }, { status: 400, headers });
    try {
      const data = await store.get("hh_" + h, { type: "json" });
      return Response.json(data || {}, { headers });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers });
    }
  }

  if (req.method === "POST") {
    try {
      const body = await req.text();
      if (body.length > MAX_BYTES) return Response.json({ error: "payload too large" }, { status: 413, headers });
      const { household, state } = JSON.parse(body);
      if (!HASH_RE.test(household || "")) return Response.json({ error: "bad household key" }, { status: 400, headers });
      if (!state || typeof state !== "object" || !Array.isArray(state.bills)) {
        return Response.json({ error: "bad state" }, { status: 400, headers });
      }
      await store.setJSON("hh_" + household, { state, savedAt: Date.now() });
      return Response.json({ ok: true }, { headers });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405, headers });
};
