// Handles push subscription registration and bill schedule sync from clients.
// Stores data in Netlify Blobs.
// Functions v2 format — Netlify Blobs auto-configures here (the old CJS handler
// broke with MissingBlobsEnvironmentError after a runtime update).

import { getStore } from "@netlify/blobs";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const store = getStore("push-subscriptions");

  if (req.method === "DELETE") {
    try {
      const { deviceId } = await req.json();
      if (!deviceId) return Response.json({ error: "missing deviceId" }, { status: 400, headers });
      await store.delete(deviceId);
      return Response.json({ ok: true }, { headers });
    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers });
    }
  }

  if (req.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers });
  }

  try {
    const { deviceId, subscription, bills, incomes } = await req.json();
    if (!deviceId || !subscription) {
      return Response.json({ error: "missing deviceId or subscription" }, { status: 400, headers });
    }
    // Store subscription + lightweight bill schedule
    // bills: [{ id, name, amount, dueDay, frequency, startMonth }]
    // incomes: [{ id, source, amount, payDay, frequency, lastPaidDate }]
    await store.setJSON(deviceId, {
      subscription,
      bills: bills || [],
      incomes: incomes || [],
      updatedAt: new Date().toISOString(),
    });
    return Response.json({ ok: true }, { headers });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers });
  }
};
