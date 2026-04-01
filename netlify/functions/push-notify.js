// Scheduled function — runs twice daily (8am and 6pm ET).
// Reads all stored subscriptions, checks which bills are due today/tomorrow,
// and sends web push notifications.

const { getStore } = require("@netlify/blobs");
const webpush = require("web-push");

// VAPID keys — public key is also in app.js client-side
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
  "mailto:npar1234@live.com",
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// Determine if a bill is due on a given day-of-month in a given month
function isBillDueOn(bill, day, month, year) {
  if (bill.dueDay !== day) return false;
  const freq = bill.frequency || "monthly";
  if (freq === "monthly" || freq === "once") return true;
  if (freq === "quarterly") {
    const startM = bill.startMonth || 0;
    return ((month - startM) % 3 + 3) % 3 === 0;
  }
  if (freq === "yearly") return month === (bill.startMonth || 0);
  return true;
}

function fmt(n) {
  return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

exports.handler = async () => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error("VAPID keys not set in environment variables");
    return { statusCode: 500, body: "VAPID keys missing" };
  }

  const store = getStore("push-subscriptions");
  const { blobs } = await store.list();

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let sent = 0;
  let errors = 0;

  for (const blob of blobs) {
    try {
      const data = await store.get(blob.key, { type: "json" });
      if (!data || !data.subscription) continue;

      const notifications = [];

      // Check bills due today
      const dueToday = (data.bills || []).filter(b =>
        isBillDueOn(b, today.getDate(), today.getMonth(), today.getFullYear())
      );
      if (dueToday.length > 0) {
        const total = dueToday.reduce((s, b) => s + Number(b.amount), 0);
        const names = dueToday.length <= 3
          ? dueToday.map(b => b.name).join(", ")
          : `${dueToday.length} bills`;
        notifications.push({
          title: `${names} due today`,
          body: `${fmt(total)} total due`,
          tag: `bills-today-${today.toISOString().slice(0, 10)}`,
        });
      }

      // Check bills due tomorrow
      const dueTmrw = (data.bills || []).filter(b =>
        isBillDueOn(b, tomorrow.getDate(), tomorrow.getMonth(), tomorrow.getFullYear())
      );
      if (dueTmrw.length > 0) {
        const total = dueTmrw.reduce((s, b) => s + Number(b.amount), 0);
        const names = dueTmrw.length <= 3
          ? dueTmrw.map(b => b.name).join(", ")
          : `${dueTmrw.length} bills`;
        notifications.push({
          title: `${names} due tomorrow`,
          body: `${fmt(total)} total — heads up!`,
          tag: `bills-tmrw-${tomorrow.toISOString().slice(0, 10)}`,
        });
      }

      // Check incomes due today (monthly only for server-side; weekly/biweekly is harder without full logic)
      const incToday = (data.incomes || []).filter(i =>
        i.payDay === today.getDate() && (!i.frequency || i.frequency === "monthly")
      );
      if (incToday.length > 0) {
        const total = incToday.reduce((s, i) => s + Number(i.amount), 0);
        const names = incToday.map(i => i.source).join(", ");
        notifications.push({
          title: `${names} expected today`,
          body: `${fmt(total)} incoming`,
          tag: `income-today-${today.toISOString().slice(0, 10)}`,
        });
      }

      // Send all notifications for this subscriber
      for (const notif of notifications) {
        try {
          await webpush.sendNotification(
            data.subscription,
            JSON.stringify(notif)
          );
          sent++;
        } catch (pushErr) {
          // 410 Gone = subscription expired, clean up
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            await store.delete(blob.key);
          }
          errors++;
        }
      }
    } catch (e) {
      console.error(`Error processing ${blob.key}:`, e.message);
      errors++;
    }
  }

  console.log(`Push notify complete: ${sent} sent, ${errors} errors, ${blobs.length} subscribers`);
  return { statusCode: 200, body: JSON.stringify({ sent, errors }) };
};

// Netlify scheduled function config — runs at 8am and 6pm ET (13:00 and 23:00 UTC)
exports.config = {
  schedule: "0 13,23 * * *",
};
