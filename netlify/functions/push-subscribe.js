// Handles push subscription registration and bill schedule sync from clients.
// Stores data in Netlify Blobs (free KV store).

const { getStore } = require("@netlify/blobs");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };

  if (event.httpMethod === "DELETE") {
    // Unsubscribe — remove stored data for this device
    try {
      const { deviceId } = JSON.parse(event.body);
      if (!deviceId) return { statusCode: 400, headers, body: '{"error":"missing deviceId"}' };
      const store = getStore("push-subscriptions");
      await store.delete(deviceId);
      return { statusCode: 200, headers, body: '{"ok":true}' };
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: '{"error":"method not allowed"}' };
  }

  try {
    const body = JSON.parse(event.body);
    const { deviceId, subscription, bills, incomes } = body;

    if (!deviceId || !subscription) {
      return { statusCode: 400, headers, body: '{"error":"missing deviceId or subscription"}' };
    }

    // Store subscription + lightweight bill schedule
    // bills: [{ id, name, amount, dueDay, frequency, startMonth }]
    // incomes: [{ id, source, amount, payDay, frequency, lastPaidDate }]
    const store = getStore("push-subscriptions");
    await store.setJSON(deviceId, {
      subscription,
      bills: bills || [],
      incomes: incomes || [],
      updatedAt: new Date().toISOString(),
    });

    return { statusCode: 200, headers, body: '{"ok":true}' };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
