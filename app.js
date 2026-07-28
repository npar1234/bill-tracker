// ═══════════════════════════════════════
//  SHARED DATA LAYER — same localStorage
// ═══════════════════════════════════════
const STORAGE_KEY = "billTracker_v3";
const SCHEMA_VERSION = 4; // v4: sync support — updatedAt stamps, deletion tombstones, plannerOvAt
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const CATEGORIES = [
  { id: "housing", label: "Housing", color: "#6366f1", icon: "🏠" },
  { id: "utilities", label: "Utilities", color: "#f59e0b", icon: "⚡" },
  { id: "subscriptions", label: "Subscriptions", color: "#ec4899", icon: "📺" },
  { id: "insurance", label: "Insurance", color: "#10b981", icon: "🛡️" },
  { id: "transportation", label: "Transportation", color: "#3b82f6", icon: "🚗" },
  { id: "phone_internet", label: "Phone & Internet", color: "#8b5cf6", icon: "📱" },
  { id: "loans", label: "Loans & Debt", color: "#ef4444", icon: "💳" },
  { id: "other", label: "Other", color: "#6b7280", icon: "📌" },
  { id: "savings", label: "Savings Transfer", color: "#10b981", icon: "💰" },
];

let state, currentTab = 'home', selectedDay = null, editBillId = null, editIncomeId = null, editSavingsId = null;

function loadState() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const p = JSON.parse(s);
      if (!p.incomes) p.incomes = [];
      if (!p.payments) p.payments = [];
      if (!p.savingsAccounts) p.savingsAccounts = [];
      if (!p.savingsTransactions) p.savingsTransactions = [];
      if (!p.categories) p.categories = JSON.parse(JSON.stringify(CATEGORIES));
      if (!p.accounts) p.accounts = [];
      if (!p.incomeReceipts) p.incomeReceipts = [];
      // Normalize bills
      p.bills = (p.bills || []).map(b => ({ biller: "", accountId: "", frequency: b.isRecurring === false ? "once" : "monthly", startMonth: 0, ...b }));
      // Legacy one-time bills have no startYear — infer it from their payment record
      // so they stop reappearing every month (unpaid legacy bills stay visible)
      p.bills.forEach(b => {
        if (b.frequency === 'once' && b.startYear === undefined) {
          const pay = (p.payments || []).find(pp => pp.billId === b.id);
          if (pay) { b.startMonth = pay.month; b.startYear = pay.year; }
        }
      });
      // Schema migration guard — snapshot the old state before upgrading shape
      if ((p.schemaVersion || 3) < SCHEMA_VERSION) {
        try { localStorage.setItem(STORAGE_KEY + '_pre_v' + SCHEMA_VERSION, s); } catch(e) {}
        p.schemaVersion = SCHEMA_VERSION;
      }
      if (!p.deletions) p.deletions = [];      // tombstones for sync merge
      if (!p.plannerOvAt) p.plannerOvAt = {};  // per-month timestamps for planner overrides
      return p;
    }
  } catch(e) {}
  const now = new Date();
  return {
    schemaVersion: SCHEMA_VERSION,
    currentMonth: now.getMonth(),
    currentYear: now.getFullYear(),
    bills: [], incomes: [], payments: [], incomeReceipts: [],
    savingsAccounts: [], savingsTransactions: [],
    categories: JSON.parse(JSON.stringify(CATEGORIES)),
    accounts: [],
    deletions: [],
    plannerOvAt: {},
  };
}

// ── Sync merge primitives: tombstones mark deletions so a second device doesn't resurrect them
function markDeleted(k) {
  if (!state.deletions) state.deletions = [];
  state.deletions.push({ k, at: Date.now() });
}
function unmarkDeleted(k) {
  if (state.deletions) state.deletions = state.deletions.filter(d => d.k !== k);
}

// Debounced push sync — avoids hammering server on rapid saves
let _pushSyncTimer = null;
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // Debounce: sync bill schedule to push server 10s after last save
    clearTimeout(_pushSyncTimer);
    _pushSyncTimer = setTimeout(() => { if (typeof syncBillScheduleToServer === 'function') syncBillScheduleToServer(); }, 10000);
    // Household sync: push merged state 3s after last change
    if (typeof queueSync === 'function') queueSync();
  } catch(e) {
    // Show a non-blocking warning if storage fails
    if (!document.getElementById('storageWarning')) {
      const w = document.createElement('div');
      w.id = 'storageWarning';
      w.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999;background:rgba(248,113,113,.9);color:#fff;padding:10px 16px;border-radius:12px;font-size:12px;font-weight:600;text-align:center;backdrop-filter:blur(12px);max-width:90%;';
      w.textContent = 'Unable to save — storage may be full. Export a backup to avoid data loss.';
      document.body.appendChild(w);
      setTimeout(() => w.remove(), 6000);
    }
  }
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// ── Haptic feedback (Android Chrome; silently ignored on iOS)
function haptic(ms = 10) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch(e) {} } }

// ── Toast with optional Undo — replaces silent state flips
let _toastTimer = null, _toastUndoFn = null;
function showToast(msg, opts = {}) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  _toastUndoFn = opts.undo || null;
  t.innerHTML = `<span class="toast-msg">${msg}</span>${opts.undo ? '<button class="toast-undo" onclick="undoToast()">Undo</button>' : ''}`;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.classList.remove('show'); _toastUndoFn = null; }, opts.duration || 4500);
}
function undoToast() {
  const fn = _toastUndoFn;
  _toastUndoFn = null;
  clearTimeout(_toastTimer);
  document.getElementById('toast')?.classList.remove('show');
  haptic(8);
  if (fn) fn();
}

// ── Animated number transitions for hero amounts
function animateAmount(el, from, to) {
  if (!el) return;
  if (from === undefined || from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const start = performance.now(), dur = 450;
  const step = now => {
    const p = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    if (p < 1) {
      el.textContent = fmt(from + (to - from) * eased);
      requestAnimationFrame(step);
    } else {
      el.innerHTML = fmtHero(to); // settle on the styled treatment
    }
  };
  requestAnimationFrame(step);
}
function fmt(n) { return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
// Hero money treatment (Copilot/Monarch style): big dollars, de-emphasized cents
function fmtHero(n) {
  const neg = n < 0;
  const [d, c] = Math.abs(Number(n)).toFixed(2).split('.');
  return `${neg ? '−' : ''}$${d.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}<span class="cents">.${c}</span>`;
}
function fmtShort(n) { return "$" + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/,"") + "k" : Number(n).toFixed(0)); }
function escHtml(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
// Local-timezone date string — toISOString() flips to tomorrow after 5pm Vegas time
function localDateISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function getCats() { return state.categories || CATEGORIES; }
function catInfo(id) { return getCats().find(c => c.id === id) || { label: id, color: "#6b7280", icon: "📌" }; }

function isDueThisMonth(bill, month, year) {
  const m = month !== undefined ? month : state.currentMonth;
  // Biweekly/weekly savings pseudo-bills are pinned to a specific month+year
  if (bill._savingsFixedMonth !== undefined) {
    const y = year !== undefined ? year : state.currentYear;
    return bill._savingsFixedMonth === m && bill._savingsFixedYear === y;
  }
  const freq = bill.frequency || "monthly";
  if (freq === "monthly") return true;
  if (freq === "once") {
    // One-time bills only appear in their creation month/year
    if (bill.startYear === undefined) return true; // legacy, unpaid — keep visible until paid
    const y = year !== undefined ? year : state.currentYear;
    return m === (bill.startMonth || 0) && y === bill.startYear;
  }
  if (freq === "quarterly") {
    const startM = bill.startMonth !== undefined ? bill.startMonth : 0;
    return ((m - startM) % 3 + 3) % 3 === 0;
  }
  if (freq === "yearly") return m === (bill.startMonth !== undefined ? bill.startMonth : 0);
  return true;
}

// Extract the real savings account ID from a pseudo-bill ID
// Monthly: "sav_abc123" → "abc123"
// Biweekly/weekly: "sav_abc123_3_15" → "abc123"
function savingsAcctIdFromBillId(billId) {
  const rest = billId.slice(4); // drop "sav_"
  // If there's a _month_day suffix, strip it
  const parts = rest.split('_');
  // Account IDs are generated by genId() which is alphanumeric (no underscores)
  // So everything after the first part is the month/day suffix
  return parts[0];
}

function isPaid(billId, month, year) {
  const m = month !== undefined ? month : state.currentMonth;
  const y = year !== undefined ? year : state.currentYear;
  // Savings contrib bills — auto-clear on or after their due date
  if (billId && billId.startsWith('sav_')) {
    const today = new Date();
    today.setHours(0,0,0,0);
    const nowM = today.getMonth(), nowY = today.getFullYear();
    // Past months: always paid. Current month: paid if today >= dueDay.
    if (y < nowY || (y === nowY && m < nowM)) return true;
    if (y === nowY && m === nowM) {
      // Find the pseudo-bill's dueDay from the generated bills
      const allSav = getSavingsContribBills();
      const bill = allSav.find(b => b.id === billId);
      const dueDay = bill ? bill.dueDay : 1;
      return today.getDate() >= dueDay;
    }
    return false; // future month
  }
  return state.payments.some(p => p.billId === billId && p.month === m && p.year === y);
}

function togglePaid(billId) {
  const m = state.currentMonth, y = state.currentYear;
  // Savings contrib bills auto-clear by date — no manual toggle
  if (billId && billId.startsWith('sav_')) return;

  const name = escHtml(state.bills.find(b => b.id === billId)?.name || 'Bill');
  const payKey = `pay:${billId}:${y}-${m}`;
  if (isPaid(billId, m, y)) {
    state.payments = state.payments.filter(p => !(p.billId === billId && p.month === m && p.year === y));
    markDeleted(payKey); // so a synced device doesn't resurrect the payment
    showToast(`${name} marked unpaid`);
  } else {
    unmarkDeleted(payKey);
    state.payments.push({ billId, month: m, year: y, date: new Date().toISOString().slice(0, 10), paidDate: new Date().toISOString().slice(0, 10), at: Date.now() });
    haptic(15);
    showToast(`✓ ${name} paid`, { undo: () => {
      state.payments = state.payments.filter(p => !(p.billId === billId && p.month === m && p.year === y));
      markDeleted(payKey);
      saveState();
      render();
    }});
  }
  saveState();
  render();
}

// Income received tracking — stored in state.incomeReceipts[]
function isIncomeReceived(incId, month, year, day) {
  if (!state.incomeReceipts) return false;
  return state.incomeReceipts.some(r => r.incomeId === incId && r.month === month && r.year === year && r.day === day);
}

function toggleIncomeReceived(incId, month, year, day) {
  if (!state.incomeReceipts) state.incomeReceipts = [];
  const rcvKey = `rcv:${incId}:${year}-${month}-${day}`;
  if (isIncomeReceived(incId, month, year, day)) {
    state.incomeReceipts = state.incomeReceipts.filter(r => !(r.incomeId === incId && r.month === month && r.year === year && r.day === day));
    markDeleted(rcvKey);
  } else {
    unmarkDeleted(rcvKey);
    state.incomeReceipts.push({ incomeId: incId, month, year, day, date: new Date().toISOString().slice(0,10), at: Date.now() });
  }
  saveState();
  render();
}

function getPaidAmount(billId, month, year) {
  const m = month !== undefined ? month : state.currentMonth;
  const y = year !== undefined ? year : state.currentYear;
  const p = state.payments.find(p => p.billId === billId && p.month === m && p.year === y);
  if (!p) return null;
  if (p.paidAmount !== undefined && p.paidAmount !== null) return p.paidAmount;
  const bill = state.bills.find(b => b.id === billId);
  return bill ? bill.amount : 0;
}

function openPayAmountModal(billId) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const current = getPaidAmount(billId) ?? bill.amount;
  document.getElementById('payAmtTitle').textContent = 'Adjust Paid Amount';
  document.getElementById('payAmtDesc').textContent = `${bill.name} · default ${fmt(bill.amount)}`;
  document.getElementById('payAmtInput').value = current.toFixed(2);
  const existing = state.payments.find(p => p.billId === billId && p.month === state.currentMonth && p.year === state.currentYear);
  document.getElementById('payConfInput').value = existing?.confirmation || '';
  document.getElementById('payAmtSaveBtn').onclick = () => {
    const amount = parseFloat(document.getElementById('payAmtInput').value);
    if (isNaN(amount) || amount < 0) return;
    const conf = document.getElementById('payConfInput').value.trim();
    const p = state.payments.find(p => p.billId === billId && p.month === state.currentMonth && p.year === state.currentYear);
    if (p) { p.paidAmount = amount; if (conf) p.confirmation = conf; p.at = Date.now(); }
    else { state.payments.push({ billId, month: state.currentMonth, year: state.currentYear, paidDate: new Date().toISOString().slice(0,10), paidAmount: amount, confirmation: conf || undefined, at: Date.now() }); }
    closeModal('payAmtModal');
    saveState();
    render();
  };
  openModal('payAmtModal');
  setTimeout(() => { const i = document.getElementById('payAmtInput'); if(i){i.focus();i.select();} }, 100);
}

function openPayeeHistory(billId) {
  const bill = state.bills.find(b => b.id === billId);
  if (!bill) return;
  const cat = catInfo(bill.category);
  const now = new Date();

  // Determine earliest tracked month: first payment record, or current month
  const billPayments = state.payments.filter(p => p.billId === billId);
  let earliestM = now.getMonth(), earliestY = now.getFullYear();
  billPayments.forEach(p => {
    if (p.year < earliestY || (p.year === earliestY && p.month < earliestM)) {
      earliestM = p.month;
      earliestY = p.year;
    }
  });

  // Build last 12 months
  const months = [];
  for (let i = 11; i >= 0; i--) {
    let m = now.getMonth() - i;
    let y = now.getFullYear();
    while (m < 0) { m += 12; y--; }
    months.push({ month: m, year: y });
  }

  const ordinal = d => { const s=['th','st','nd','rd']; const v=d%100; return d+(s[(v-20)%10]||s[v]||s[0]); };

  const cells = months.map(({ month, year }) => {
    const isFuture = (year > now.getFullYear()) || (year === now.getFullYear() && month > now.getMonth());
    // Before tracking started: show as untracked
    const isBeforeTracking = (year < earliestY) || (year === earliestY && month < earliestM);
    const paid = isPaid(billId, month, year);
    const pRec = state.payments.find(p => p.billId === billId && p.month === month && p.year === year);
    const dayPaid = paid && pRec?.paidDate ? new Date(pRec.paidDate + 'T12:00:00').getDate() : null;

    let cls, statusIcon, sub;
    if (isFuture) {
      cls = 'future'; statusIcon = '—'; sub = '';
    } else if (isBeforeTracking && !paid) {
      cls = 'untracked'; statusIcon = '—'; sub = '<div class="hg-date">Not tracked</div>';
    } else if (paid) {
      cls = 'paid'; statusIcon = '✅';
      const conf = pRec?.confirmation ? ` <span title="${escHtml(pRec.confirmation)}">#</span>` : '';
      sub = dayPaid ? `<div class="hg-date">Paid ${ordinal(dayPaid)}${conf}</div>` : `<div class="hg-date">Paid${conf}</div>`;
    } else {
      cls = 'missed'; statusIcon = '❌'; sub = '<div class="hg-date">Missed</div>';
    }
    return `<div class="hg-cell ${cls}"><div class="hg-month">${SHORT_MONTHS[month]} ${year}</div><div class="hg-status">${statusIcon}</div>${sub}</div>`;
  }).join('');

  // Only count tracked months for the percentage
  const trackedMonths = months.filter(({month, year}) => {
    const isFuture = (year > now.getFullYear()) || (year === now.getFullYear() && month > now.getMonth());
    const isBeforeTracking = (year < earliestY) || (year === earliestY && month < earliestM);
    return !isFuture && !isBeforeTracking;
  });
  const paidCount = trackedMonths.filter(({month, year}) => isPaid(billId, month, year)).length;
  const trackedCount = trackedMonths.length;
  const pct = trackedCount > 0 ? Math.round((paidCount / trackedCount) * 100) : 0;
  const missedCount = trackedCount - paidCount;

  document.getElementById('historyContent').innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div style="width:36px;height:36px;border-radius:10px;background:${cat.color}30;display:flex;align-items:center;justify-content:center;font-size:16px">${bill.icon || cat.icon}</div>
      <div>
        <div style="font-size:14px;font-weight:700">${escHtml(bill.name)}</div>
        <div style="font-size:11px;color:var(--text3)">${cat.label} · ${fmt(bill.amount)}/mo · Due day ${bill.dueDay}</div>
      </div>
    </div>
    <div class="hg-summary">
      <span>✅ <strong style="color:var(--paid)">${paidCount}</strong> paid</span>
      ${missedCount > 0 ? `<span>❌ <strong style="color:var(--expense)">${missedCount}</strong> missed</span>` : ''}
      <span style="margin-left:auto;color:var(--accent);font-weight:700">${pct}% on-time</span>
    </div>
    <div class="history-grid">${cells}</div>
  `;
  openModal('historyModal');
}

function getDueDate(bill, month, year) {
  const m = month !== undefined ? month : state.currentMonth;
  const y = year !== undefined ? year : state.currentYear;
  const day = Math.min(bill.dueDay, new Date(y, m+1, 0).getDate());
  return `${y}-${String(m+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function daysUntil(dateStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.ceil((new Date(dateStr+"T00:00:00") - today) / 86400000);
}

// Income pay date calculation — mirrors the full app
function getNextPayDates(income, count) {
  const dates = [];
  const n = count || 6;
  if (!income.lastPaidDate) {
    const day = income.payDay || 1;
    for (let m = 0; m < (n > 3 ? n : 3); m++) {
      dates.push(new Date(state.currentYear, state.currentMonth + m, Math.min(day, 28)));
    }
    return dates;
  }

  const anchor = new Date(income.lastPaidDate + 'T12:00:00');
  const freq = income.frequency || 'monthly';
  const viewStart = new Date(state.currentYear, state.currentMonth, 1);
  viewStart.setHours(12, 0, 0, 0);

  if (freq === 'weekly' || freq === 'biweekly') {
    // Pure arithmetic — no Date mutation, no stepping drift
    const cycleDays = freq === 'weekly' ? 7 : 14;
    const msPerDay = 86400000;
    const anchorMs = anchor.getTime();
    const viewMs = viewStart.getTime();

    // How many full cycles from anchor to viewStart
    const diffDays = Math.floor((viewMs - anchorMs) / msPerDay);
    // First cycle index that lands on or after viewStart
    let cycleIdx = Math.ceil(diffDays / cycleDays);
    // Step back one cycle to catch a date that falls at or just after the 1st
    cycleIdx--;
    if (new Date(anchorMs + cycleIdx * cycleDays * msPerDay) < viewStart) cycleIdx++;

    for (let i = 0; i < n; i++) {
      dates.push(new Date(anchorMs + (cycleIdx + i) * cycleDays * msPerDay));
    }
    return dates;
  }

  // Monthly / yearly — use Date stepping (no drift risk for these)
  let d = new Date(anchor);
  const step = () => {
    if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
  };
  const stepBack = () => {
    if (freq === 'monthly') d.setMonth(d.getMonth() - 1);
    else d.setFullYear(d.getFullYear() - 1);
  };
  // Advance to viewStart
  for (let i = 0; i < 200 && d < viewStart; i++) step();
  // Check one step back in case it's still in the viewed month
  const saved = new Date(d);
  stepBack();
  if (d < viewStart) d = new Date(saved);
  for (let i = 0; i < n; i++) { dates.push(new Date(d)); step(); }
  return dates;
}

// Savings contributions as pseudo-bills
// Monthly: one bill per month on contribDay
// Biweekly/weekly: multiple bills per month, computed from contribStart
function getSavingsContribBills() {
  const bills = [];
  (state.savingsAccounts || []).filter(a => a.contrib > 0).forEach(a => {
    const freq = a.contribFreq || 'monthly';
    if (freq === 'monthly') {
      bills.push({
        id: 'sav_' + a.id,
        name: a.name + ' Deposit',
        amount: a.contrib,
        dueDay: a.contribDay || 1,
        category: 'savings',
        frequency: 'monthly',
        payMethod: 'autopay',
        icon: '💰',
        _isSavingsContrib: true,
      });
    } else {
      // Biweekly or weekly: generate pseudo-income object to reuse getNextPayDates
      // then create one pseudo-bill per occurrence in the viewed month range
      const intervalDays = freq === 'biweekly' ? 14 : 7;
      const start = a.contribStart ? new Date(a.contribStart + 'T00:00:00') : new Date();
      // Generate dates covering ~3 months ahead
      const dates = [];
      const d = new Date(start);
      const limit = new Date();
      limit.setMonth(limit.getMonth() + 3);
      while (d <= limit) {
        dates.push(new Date(d));
        d.setDate(d.getDate() + intervalDays);
      }
      dates.forEach((dt, i) => {
        bills.push({
          id: 'sav_' + a.id + '_' + dt.getMonth() + '_' + dt.getDate(),
          name: a.name + ' Deposit',
          amount: a.contrib,
          dueDay: dt.getDate(),
          category: 'savings',
          frequency: 'monthly', // treated as monthly for isDueThisMonth — each instance is per-month
          payMethod: 'autopay',
          icon: '💰',
          _isSavingsContrib: true,
          _savingsFixedMonth: dt.getMonth(), // only show in this specific month
          _savingsFixedYear: dt.getFullYear(),
        });
      });
    }
  });
  return bills;
}

// Compute savings balance: daily simulation from the last known balance —
// compounds APY interest daily and adds auto-deposits on their scheduled days.
// balanceAsOf rebases the projection whenever the user corrects the balance.
function computedBalance(acctId) {
  const acct = (state.savingsAccounts || []).find(a => a.id === acctId);
  if (!acct) return 0;
  let bal = acct.balance || 0;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const asOf = acct.balanceAsOf ? new Date(acct.balanceAsOf + 'T00:00:00')
    : acct.contribStart ? new Date(acct.contribStart + 'T00:00:00') : null;

  // Manual transactions — but only ones AFTER the balance anchor. Anything on or
  // before it is already baked into the balance the user typed (old interest
  // entries from the full app were being double-counted on top of fresh balances).
  (state.savingsTransactions || []).filter(t => {
    if (t.accountId !== acctId || t._pseudoBillId) return false;
    if (acct.balanceAsOf) {
      if (!t.date) return false;
      return new Date(t.date + 'T00:00:00') > new Date(acct.balanceAsOf + 'T00:00:00');
    }
    return true; // no anchor set yet — legacy behavior
  }).forEach(t => {
    if (t.type === 'deposit' || t.type === 'interest') bal += t.amount;
    else if (t.type === 'withdrawal') bal -= t.amount;
  });

  if (!asOf || asOf >= today) return bal;

  const dailyRate = acct.apy > 0 ? Math.pow(1 + acct.apy / 100, 1 / 365) - 1 : 0;
  const freq = acct.contribFreq || 'monthly';
  const interval = freq === 'biweekly' ? 14 : freq === 'weekly' ? 7 : 0;
  const start = (acct.contrib > 0 && acct.contribStart) ? new Date(acct.contribStart + 'T00:00:00') : null;

  for (let d = new Date(asOf.getTime() + 86400000); d <= today; d.setDate(d.getDate() + 1)) {
    if (dailyRate) bal *= 1 + dailyRate;
    if (start && d >= start && acct.contrib > 0) {
      if (freq === 'monthly') {
        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        if (d.getDate() === Math.min(acct.contribDay || 1, dim)) bal += acct.contrib;
      } else if (Math.round((d - start) / 86400000) % interval === 0) {
        bal += acct.contrib;
      }
    }
  }
  return bal;
}

// ═══════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════
function switchTab(tab) {
  if (tab !== currentTab) haptic(5);
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === 'tab-' + tab));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));
  // Ambient page glow per tab
  document.body.classList.remove('glow-home','glow-bills','glow-income','glow-savings','glow-planner');
  document.body.classList.add('glow-' + tab);
  render();
}

// Section collapse state persisted in sessionStorage
function toggleSection(zoneId) {
  const el = document.getElementById(zoneId);
  if (!el) return;
  el.classList.toggle('collapsed');
  // Remember collapsed state for session
  const key = 'sl_collapsed';
  const collapsed = JSON.parse(sessionStorage.getItem(key) || '{}');
  collapsed[zoneId] = el.classList.contains('collapsed');
  sessionStorage.setItem(key, JSON.stringify(collapsed));
}
function restoreCollapsed() {
  const collapsed = JSON.parse(sessionStorage.getItem('sl_collapsed') || '{}');
  Object.keys(collapsed).forEach(id => {
    if (collapsed[id]) document.getElementById(id)?.classList.add('collapsed');
  });
}

function changeMonth(delta) {
  state.currentMonth += delta;
  if (state.currentMonth > 11) { state.currentMonth = 0; state.currentYear++; }
  if (state.currentMonth < 0) { state.currentMonth = 11; state.currentYear--; }
  selectedDay = null;
  saveState();
  render();
}

// Tap the month label to jump back to the current month
function goToToday() {
  const now = new Date();
  state.currentMonth = now.getMonth();
  state.currentYear = now.getFullYear();
  selectedDay = null;
  saveState();
  render();
}

function plannerGoToToday() {
  const now = new Date();
  plannerMonth = now.getMonth();
  plannerYear = now.getFullYear();
  render();
}

// ═══════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════
// Autopay bills clear themselves once their due date passes (Bills Organizer pattern).
// Respects tombstones: if the user manually un-paid it, we don't re-clear it.
function autoClearAutopay() {
  const today = new Date(); today.setHours(0,0,0,0);
  let changed = false;
  state.bills.filter(b => b.payMethod === 'autopay').forEach(b => {
    for (let off = 1; off >= 0; off--) { // previous + current month
      const d = new Date(today.getFullYear(), today.getMonth() - off, 1);
      const mm = d.getMonth(), yy = d.getFullYear();
      if (!isDueThisMonth(b, mm, yy)) continue;
      const dueDate = new Date(yy, mm, Math.min(b.dueDay, new Date(yy, mm + 1, 0).getDate()));
      if (dueDate > today) continue;
      if (isPaid(b.id, mm, yy)) continue;
      if ((state.deletions || []).some(dd => dd.k === `pay:${b.id}:${yy}-${mm}`)) continue; // user said no
      state.payments.push({ billId: b.id, month: mm, year: yy, paidDate: dueDate.toISOString().slice(0, 10), at: Date.now(), auto: true });
      changed = true;
    }
  });
  if (changed) saveState();
}

function render() {
  state = loadState(); // Re-read in case the full app wrote changes
  autoClearAutopay();

  const now = new Date();
  const todayStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('headerDate').textContent = todayStr;
  document.getElementById('monthLabel').textContent = `${MONTHS[state.currentMonth]} ${state.currentYear}`;

  const allBills = state.bills.concat(getSavingsContribBills());
  const monthBills = allBills.filter(b => isDueThisMonth(b));

  if (currentTab === 'home') renderHome(monthBills);
  if (currentTab === 'bills') renderBills(monthBills);
  if (currentTab === 'planner') renderPlannerTab();
  if (currentTab === 'income') renderIncomeTab();
  if (currentTab === 'savings') renderSavings();
  if (typeof updateAppBadge === 'function') updateAppBadge();
}

function renderHome(monthBills) {
  // ── First-launch welcome: teach the two actions that make the app useful
  const oldWelcome = document.getElementById('welcomeCard');
  if (oldWelcome) oldWelcome.remove();
  if (!state.bills.length && !state.incomes.length) {
    const w = document.createElement('div');
    w.id = 'welcomeCard';
    w.className = 'welcome-card';
    w.innerHTML = `
      <div class="welcome-title">👋 Welcome to SimpleLedger</div>
      <p class="welcome-text">Track bills, plan paychecks, never miss a due date. Two steps to get going:</p>
      <div class="welcome-actions">
        <button class="empty-cta" style="margin-top:0" onclick="openIncomeModal()">1 · Add your income</button>
        <button class="empty-cta" style="margin-top:0;background:var(--expense)" onclick="openBillModal()">2 · Add your bills</button>
      </div>`;
    const homeTab = document.getElementById('tab-home');
    homeTab.insertBefore(w, homeTab.firstChild);
  }

  // ── Pay-date reminder: warn if any income is missing lastPaidDate
  const missingPayDate = state.incomes.filter(i => !i.lastPaidDate);
  const reminderEl = document.getElementById('payDateReminder');
  if (reminderEl) reminderEl.remove();
  if (missingPayDate.length > 0) {
    const names = missingPayDate.map(i => i.name || 'Unnamed').join(', ');
    const banner = document.createElement('div');
    banner.id = 'payDateReminder';
    banner.className = 'pay-date-reminder';
    banner.innerHTML = `⚠️ <strong>${missingPayDate.length > 1 ? 'Some income sources need' : names + ' needs'} a Last Paid Date</strong> — salary won't appear on the calendar without it. <a href="#" onclick="event.preventDefault();switchTab('income')">Fix now →</a>`;
    const homeTab = document.getElementById('tab-home');
    homeTab.insertBefore(banner, homeTab.firstChild);
  }

  // ── Summary strip
  const totalBills = monthBills.reduce((s, b) => s + b.amount, 0);
  const totalIncome = state.incomes.reduce((s, inc) => {
    if (inc.frequency === 'biweekly') return s + (inc.amount * 26 / 12);
    if (inc.frequency === 'weekly') return s + (inc.amount * 52 / 12);
    if (inc.frequency === 'yearly') return s + (inc.amount / 12);
    return s + inc.amount;
  }, 0);
  const paidTotal = monthBills.filter(b => isPaid(b.id)).reduce((s, b) => s + b.amount, 0);
  const remaining = totalIncome - totalBills;

  // Track previous values for pop animation
  const _prev = window._chipVals || {};
  const _cur = { inc: totalIncome, bill: totalBills, left: remaining };
  document.getElementById('summaryStrip').innerHTML = `
    <div class="summary-chip chip-income${_prev.inc !== undefined && _prev.inc !== _cur.inc ? ' pop' : ''}"><div class="chip-label">Income</div><div class="chip-value">${fmtShort(totalIncome)}</div></div>
    <div class="summary-chip chip-bills${_prev.bill !== undefined && _prev.bill !== _cur.bill ? ' pop' : ''}"><div class="chip-label">Bills</div><div class="chip-value">${fmtShort(totalBills)}</div></div>
    <div class="summary-chip chip-left${_prev.left !== undefined && _prev.left !== _cur.left ? ' pop' : ''}"><div class="chip-label">Uncommitted</div><div class="chip-value${remaining < 0 ? ' negative' : ''}">${fmtShort(remaining)}</div></div>
  `;
  window._chipVals = _cur;

  // ── Progress bars
  const paidCount = monthBills.filter(b => isPaid(b.id)).length;
  const totalCount = monthBills.length;
  const paidPct = totalBills > 0 ? Math.round((paidTotal / totalBills) * 100) : 0;
  const countPct = totalCount > 0 ? Math.round((paidCount / totalCount) * 100) : 0;
  const incPct = totalIncome > 0 ? Math.round((totalBills / totalIncome) * 100) : 0;

  // Bar color: red → yellow → green based on percentage
  const barColor = pct => {
    if (pct < 40) return '#f87171';       // red
    if (pct < 70) return '#e8b500';       // yellow
    return '#2dd4a8';                      // green
  };
  const barGlow = pct => {
    if (pct < 40) return 'rgba(248,113,113,.4)';
    if (pct < 70) return 'rgba(232,181,0,.4)';
    return 'rgba(45,212,168,.4)';
  };

  document.getElementById('progressBars').innerHTML = `
    <div class="progress-bar-wrap">
      <div class="pb-header">
        <span class="pb-label">Bills Paid This Month</span>
        <span class="pb-stat">${fmt(paidTotal)} of ${fmt(totalBills)} · ${incPct}% of income</span>
      </div>
      <div style="display:flex;align-items:center">
        <div class="pb-track" style="flex:1"><div class="pb-fill" style="width:${paidPct}%;background:${barColor(paidPct)};box-shadow:0 0 8px ${barGlow(paidPct)}"></div></div>
        <span class="pb-pct" style="color:${barColor(paidPct)}">${paidPct}%</span>
      </div>
    </div>
    <div class="progress-bar-wrap">
      <div class="pb-header">
        <span class="pb-label">Payment Progress</span>
        <span class="pb-stat">${paidCount}/${totalCount} paid</span>
      </div>
      <div style="display:flex;align-items:center">
        <div class="pb-track" style="flex:1"><div class="pb-fill" style="width:${countPct}%;background:${barColor(countPct)};box-shadow:0 0 8px ${barGlow(countPct)}"></div></div>
        <span class="pb-pct" style="color:${barColor(countPct)}">${countPct}%</span>
      </div>
    </div>
  `;

  // ── Money headline pills: due this week, overdue, month-over-month delta
  const today0 = new Date(); today0.setHours(0,0,0,0);
  let dueWeek = 0, overdueAmt = 0;
  [0, 1].forEach(offset => {
    const cm = (state.currentMonth + offset) % 12;
    const cy = state.currentMonth + offset > 11 ? state.currentYear + 1 : state.currentYear;
    const dim = new Date(cy, cm + 1, 0).getDate();
    state.bills.concat(getSavingsContribBills()).filter(b => isDueThisMonth(b, cm, cy)).forEach(b => {
      if (isPaid(b.id, cm, cy)) return;
      const dt = new Date(cy, cm, Math.min(b.dueDay, dim));
      const du = Math.ceil((dt - today0) / 86400000);
      if (du >= 0 && du < 7) dueWeek += b.amount;
      if (offset === 0 && du < 0) overdueAmt += b.amount;
    });
  });
  // Delta vs last month (real bills only, not savings pseudo-bills)
  const pm = state.currentMonth === 0 ? 11 : state.currentMonth - 1;
  const py = state.currentMonth === 0 ? state.currentYear - 1 : state.currentYear;
  const prevTotal = state.bills.filter(b => isDueThisMonth(b, pm, py)).reduce((s, b) => s + b.amount, 0);
  const curTotal = state.bills.filter(b => isDueThisMonth(b, state.currentMonth, state.currentYear)).reduce((s, b) => s + b.amount, 0);
  const diff = curTotal - prevTotal;
  const pills = [];
  if (dueWeek > 0) pills.push(`<span class="home-pill">📅 ${fmt(dueWeek)} due in the next 7 days</span>`);
  if (overdueAmt > 0) pills.push(`<span class="home-pill pill-red">⚠️ ${fmt(overdueAmt)} overdue</span>`);
  if (prevTotal > 0 && Math.abs(diff) >= 1) {
    pills.push(`<span class="home-pill ${diff > 0 ? 'pill-red' : 'pill-green'}">${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${SHORT_MONTHS[pm]}</span>`);
  }
  let pillsEl = document.getElementById('homePills');
  if (!pillsEl) {
    pillsEl = document.createElement('div');
    pillsEl.id = 'homePills';
    document.getElementById('progressBars').after(pillsEl);
  }
  pillsEl.innerHTML = pills.join('');

  // ── Payday moment: contextual hero on the day a check lands
  const payToday = new Date(); payToday.setHours(0,0,0,0);
  const payISO = payToday.toISOString().slice(0,10);
  const oldPd = document.getElementById('paydayBanner');
  if (oldPd) oldPd.remove();
  if (!sessionStorage.getItem('sl_payday_' + payISO)) {
    const smv = state.currentMonth, syv = state.currentYear;
    state.currentMonth = payToday.getMonth(); state.currentYear = payToday.getFullYear();
    const landed = state.incomes.filter(inc =>
      getNextPayDates(inc, 8).some(dt => dt.getFullYear() === payToday.getFullYear() && dt.getMonth() === payToday.getMonth() && dt.getDate() === payToday.getDate()));
    // Next payday across all incomes (horizon for "this check covers…")
    let nextPay = null;
    state.incomes.forEach(inc => getNextPayDates(inc, 8).forEach(dt => {
      const dd = new Date(dt); dd.setHours(0,0,0,0);
      if (dd > payToday && (!nextPay || dd < nextPay)) nextPay = dd;
    }));
    state.currentMonth = smv; state.currentYear = syv;
    if (landed.length) {
      const landedTotal = landed.reduce((s, i) => s + i.amount, 0);
      const horizon = nextPay || new Date(payToday.getTime() + 14 * 86400000);
      // Unpaid bills due between today and the next check
      let covers = [], coverTotal = 0;
      [0, 1].forEach(off => {
        const base = new Date(payToday.getFullYear(), payToday.getMonth() + off, 1);
        const bm = base.getMonth(), by = base.getFullYear();
        const dim = new Date(by, bm + 1, 0).getDate();
        state.bills.concat(getSavingsContribBills()).filter(b => isDueThisMonth(b, bm, by)).forEach(b => {
          if (isPaid(b.id, bm, by)) return;
          const dd = new Date(by, bm, Math.min(b.dueDay, dim));
          if (dd >= payToday && dd < horizon) { covers.push(b); coverTotal += b.amount; }
        });
      });
      const left = landedTotal - coverTotal;
      const pd = document.createElement('div');
      pd.id = 'paydayBanner';
      pd.className = 'payday-banner';
      pd.innerHTML = `
        <button class="payday-close" onclick="sessionStorage.setItem('sl_payday_${payISO}','1');this.parentNode.remove()">✕</button>
        <div class="payday-title">💵 Payday — ${landed.map(i => escHtml(i.name)).join(' + ')} landed</div>
        <div class="payday-amt">+${fmtHero(landedTotal)}</div>
        <div class="payday-sub">Covers ${covers.length} bill${covers.length !== 1 ? 's' : ''} (${fmt(coverTotal)}) until your next check · <b style="color:${left < 0 ? 'var(--expense)' : 'var(--paid)'}">${fmt(left)}</b> yours to spend</div>`;
      const homeTab = document.getElementById('tab-home');
      homeTab.insertBefore(pd, homeTab.firstChild);
    }
  }

  // ── Cash Flow Ribbon
  renderCashRibbon();

  // ── Calendar
  renderCalendar(monthBills);

  // ── Day detail
  if (selectedDay) renderDayDetail(monthBills);
  else document.getElementById('dayDetail').innerHTML = '';

  // ── Upcoming (next 14 days)
  renderUpcoming(monthBills);
}

function renderCalendar(monthBills) {
  const y = state.currentYear, m = state.currentMonth;
  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getMonth() === m && today.getFullYear() === y;
  const todayDate = today.getDate();

  // Build a map: day -> events
  const dayMap = {};
  for (let d = 1; d <= daysInMonth; d++) dayMap[d] = { bills: [], incomes: [] };

  monthBills.forEach(b => {
    const day = Math.min(b.dueDay, daysInMonth);
    if (dayMap[day]) dayMap[day].bills.push(b);
  });

  // Income dates
  state.incomes.forEach(inc => {
    const dates = getNextPayDates(inc, 8);
    dates.forEach(d => {
      if (d.getMonth() === m && d.getFullYear() === y) {
        const day = d.getDate();
        if (dayMap[day]) dayMap[day].incomes.push(inc);
      }
    });
  });

  let html = '';
  // Empty cells
  for (let i = 0; i < firstDay; i++) html += '<div class="cal-cell empty"><span class="cal-day"></span></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const isToday = isCurrentMonth && d === todayDate;
    const isPast = isCurrentMonth && d < todayDate;
    const isSel = selectedDay === d;
    let cls = 'cal-cell';
    if (isToday) cls += ' today';
    if (isPast && !isToday) cls += ' past';
    if (isSel) cls += ' selected';

    const events = dayMap[d];
    let dots = '';
    // Show up to 3 dots — color by type: red=bill, green=income, yellow=savings
    const regularBills = events.bills.filter(b => !b._isSavingsContrib).slice(0, 2);
    const savingsBills = events.bills.filter(b => b._isSavingsContrib).slice(0, 1);
    const billDots = regularBills.map(b => {
      const paid = isPaid(b.id);
      return `<div class="cal-dot bill${paid ? ' is-paid' : ''}"></div>`;
    }).join('');
    const savDots = savingsBills.map(() => '<div class="cal-dot savings"></div>').join('');
    const incDots = events.incomes.slice(0, 1).map(() => '<div class="cal-dot income"></div>').join('');
    dots = billDots + savDots + incDots;

    html += `<div class="${cls}" onclick="selectDay(${d})"><span class="cal-day">${d}</span><div class="cal-dots">${dots}</div></div>`;
  }

  document.getElementById('calGrid').innerHTML = html;
}

function selectDay(d) {
  selectedDay = selectedDay === d ? null : d;
  render();
}

function renderDayDetail(monthBills) {
  const d = selectedDay;
  const y = state.currentYear, m = state.currentMonth;
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const dayName = DAY_NAMES[new Date(dateStr + 'T00:00:00').getDay()];

  const bills = monthBills.filter(b => Math.min(b.dueDay, daysInMonth) === d);
  const incomes = [];
  state.incomes.forEach(inc => {
    getNextPayDates(inc, 8).forEach(dt => {
      if (dt.getMonth() === m && dt.getFullYear() === y && dt.getDate() === d) incomes.push(inc);
    });
  });

  if (!bills.length && !incomes.length) {
    document.getElementById('dayDetail').innerHTML = `
      <div class="day-detail">
        <div class="day-detail-header">${dayName}, ${SHORT_MONTHS[m]} ${d}<button class="day-detail-close" onclick="selectedDay=null;render()">✕</button></div>
        <div style="padding:16px;text-align:center;color:var(--text3);font-size:13px">Nothing scheduled</div>
      </div>`;
    return;
  }

  let items = '';
  bills.forEach(b => {
    const paid = isPaid(b.id);
    const cat = catInfo(b.category);
    const du = daysUntil(dateStr);
    let badge = '';
    if (paid) badge = '<span class="day-item-badge badge-paid">Paid</span>';
    else if (du < 0) badge = `<span class="day-item-badge badge-overdue">${Math.abs(du)}d overdue</span>`;
    else if (du <= 3) badge = `<span class="day-item-badge badge-due">${du === 0 ? 'Today' : du + 'd'}</span>`;

    items += `<div class="day-item">
      <button class="bill-pay-btn${paid ? ' is-paid' : ''}" onclick="event.stopPropagation();togglePaid('${b.id}')">${paid ? '✓ Paid' : 'Pay'}</button>
      <div class="day-icon ${paid ? 'paid-icon' : 'bill-icon'}">${b.icon || cat.icon}</div>
      <div class="day-item-info"><div class="day-item-name">${escHtml(b.name)}</div><div class="day-item-meta">${cat.label}${b.payMethod === 'autopay' ? ' · Autopay' : ''}</div></div>
      <div><div class="day-item-amount ${paid ? 'paid' : 'expense'}">${fmt(b.amount)}</div>${badge}</div>
    </div>`;
  });

  incomes.forEach(inc => {
    const incReceived = isIncomeReceived(inc.id, m, y, d);
    items += `<div class="day-item">
      <button class="bill-pay-btn${incReceived ? ' is-paid' : ''}" style="${!incReceived ? 'background:linear-gradient(145deg,rgba(45,212,168,.15),rgba(45,212,168,.06));color:var(--income);border-color:rgba(45,212,168,.15)' : ''}" onclick="event.stopPropagation();toggleIncomeReceived('${inc.id}',${m},${y},${d})">${incReceived ? '✓ Recv' : 'Recv'}</button>
      <div class="day-icon income-icon">💵</div>
      <div class="day-item-info"><div class="day-item-name">${escHtml(inc.name)}</div><div class="day-item-meta">Payday</div></div>
      <div class="day-item-amount income">+${fmt(inc.amount)}</div>
    </div>`;
  });

  document.getElementById('dayDetail').innerHTML = `
    <div class="day-detail fade-in">
      <div class="day-detail-header">${dayName}, ${SHORT_MONTHS[m]} ${d}<button class="day-detail-close" onclick="selectedDay=null;render()">✕</button></div>
      ${items}
    </div>`;
}

function renderUpcoming(monthBills) {
  const now = new Date();
  now.setHours(0,0,0,0);
  const y = state.currentYear, m = state.currentMonth;

  // Collect all events for next 30 days
  let events = [];

  // Bills for current and next month
  [0, 1].forEach(offset => {
    const cm = (m + offset) % 12;
    const cy = m + offset > 11 ? y + 1 : y;
    const dim = new Date(cy, cm+1, 0).getDate();
    const bills = state.bills.concat(getSavingsContribBills()).filter(b => isDueThisMonth(b, cm, cy));
    bills.forEach(b => {
      const day = Math.min(b.dueDay, dim);
      const dateStr = `${cy}-${String(cm+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      const dt = new Date(dateStr + 'T00:00:00');
      const du = Math.ceil((dt - now) / 86400000);
      if (du >= -3 && du <= 30) {
        events.push({ type: 'bill', bill: b, date: dateStr, dt, du, paid: isPaid(b.id, cm, cy), month: cm, year: cy });
      }
    });
  });

  // Incomes
  state.incomes.forEach(inc => {
    getNextPayDates(inc, 8).forEach(dt => {
      const du = Math.ceil((dt - now) / 86400000);
      if (du >= -1 && du <= 30) {
        const dateStr = dt.toISOString().slice(0,10);
        const received = isIncomeReceived(inc.id, dt.getMonth(), dt.getFullYear(), dt.getDate());
        events.push({ type: 'income', income: inc, date: dateStr, dt, du, received });
      }
    });
  });

  events.sort((a, b) => a.dt - b.dt);

  // Remove paid bills and received income from the list
  events = events.filter(e => {
    if (e.type === 'bill') return !e.paid;
    if (e.type === 'income') return !e.received;
    return true;
  });

  const count = events.length;
  document.getElementById('upcomingCount').textContent = `${count} upcoming`;

  if (!events.length) {
    document.getElementById('upcomingList').innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div>No upcoming bills or paydays<br><button class="empty-cta" onclick="openAddModal()">＋ Get Started</button></div>';
    return;
  }

  // Week-based separators: Overdue, This Week, Next Week, In 2 Weeks, etc.
  function weekLabel(du) {
    if (du < 0) return 'Overdue';
    if (du <= 1) return 'Today / Tomorrow';
    // Calculate which week this falls in (Sun-Sat)
    const now = new Date(); now.setHours(0,0,0,0);
    const dayOfWeek = now.getDay(); // 0=Sun
    const endOfThisWeek = 6 - dayOfWeek; // days until Saturday
    if (du <= endOfThisWeek) return 'This Week';
    if (du <= endOfThisWeek + 7) return 'Next Week';
    const weeksOut = Math.ceil((du - endOfThisWeek) / 7);
    return `In ${weeksOut} Week${weeksOut > 1 ? 's' : ''}`;
  }

  let lastWeekLabel = '';
  document.getElementById('upcomingList').innerHTML = events.slice(0, 25).map((e, i, arr) => {
    let divider = '';
    const wl = weekLabel(e.du);
    if (wl !== lastWeekLabel) {
      divider = `<div class="month-divider"><div class="month-divider-line"></div><span class="month-divider-label">${wl}</span><div class="month-divider-line"></div></div>`;
      lastWeekLabel = wl;
    }

    if (e.type === 'income') {
      const dayLabel = e.du === 0 ? 'Today' : e.du === 1 ? 'Tomorrow' : `${SHORT_MONTHS[e.dt.getMonth()]} ${e.dt.getDate()}`;
      return divider + `<div class="upcoming-card income-card" onclick="switchTab('income')">
        <div class="up-icon income">💵</div>
        <div class="up-info"><div class="up-name">${escHtml(e.income.name)}</div><div class="up-meta">${dayLabel} · Payday</div></div>
        <div class="up-right"><div class="up-amount income">+${fmt(e.income.amount)}</div></div>
      </div>`;
    }
    const b = e.bill;
    const cat = catInfo(b.category);
    const dayLabel = e.du === 0 ? 'Today' : e.du === 1 ? 'Tomorrow' : e.du < 0 ? `${Math.abs(e.du)}d overdue` : `${SHORT_MONTHS[e.dt.getMonth()]} ${e.dt.getDate()}`;
    let badgeHtml = '';
    if (e.paid) badgeHtml = '<span class="day-item-badge badge-paid" style="font-size:9px">Paid</span>';
    else if (e.du < 0) badgeHtml = '<span class="day-item-badge badge-overdue" style="font-size:9px">Overdue</span>';
    else if (e.du <= 1) badgeHtml = '<span class="day-item-badge badge-due" style="font-size:9px">Due</span>';

    return divider + `<div class="upcoming-card${e.paid ? ' is-paid' : ''}" onclick="switchTab('bills')">
      <div class="up-icon bill${e.paid ? ' paid' : ''}">${b.icon || cat.icon}</div>
      <div class="up-info"><div class="up-name">${escHtml(b.name)}</div><div class="up-meta">${dayLabel}${b.payMethod === 'autopay' ? ' · Autopay' : ''}</div></div>
      <div class="up-right"><div class="up-amount ${e.paid ? 'paid' : 'expense'}">${fmt(b.amount)}</div><div class="up-badge">${badgeHtml}</div></div>
    </div>`;
  }).join('');
}

// ── Paycheck planner
function renderPaycheckPlanner(monthBills) {
  const y = state.currentYear, m = state.currentMonth;
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const mo = SHORT_MONTHS[m];

  const plannerBills = monthBills.filter(b => !b.excludeFromPlanner);
  const plannerIncomes = state.incomes.filter(inc => !inc.excludeFromPlanner);

  let payDates = [];
  plannerIncomes.forEach(inc => {
    getNextPayDates(inc, 8).forEach(dt => {
      if (dt.getMonth() === m && dt.getFullYear() === y) {
        payDates.push({ date: dt.getDate(), income: inc, amount: inc.amount, dt });
      }
    });
  });
  payDates.sort((a, b) => a.date - b.date);

  const excludedCount = state.incomes.length - plannerIncomes.length + monthBills.length - plannerBills.length;

  if (!payDates.length) {
    document.getElementById('paycheckCount').textContent = 'No income';
    document.getElementById('paycheckList').innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-icon">💵</div>${plannerIncomes.length === 0 && state.incomes.length > 0 ? 'All income sources excluded from planner.<br><span style="font-size:11px;color:var(--text3)">Edit an income source to include it.</span>' : 'Add income sources to see paycheck allocation'}</div>`;
    return;
  }

  document.getElementById('paycheckCount').textContent = `${payDates.length} paycheck${payDates.length !== 1 ? 's' : ''}${excludedCount ? ' · ' + excludedCount + ' excluded' : ''}`;

  // ── Step 1: Build pay periods with actual pay date boundaries
  const periods = payDates.map((pd, i) => {
    const periodStart = pd.date;
    const periodEnd = i < payDates.length - 1 ? payDates[i+1].date - 1 : daysInMonth;
    return { ...pd, periodStart, periodEnd, bills: [], movedBills: new Set(), isPrePaycheck: false };
  });

  // Bills due before first paycheck silently go into the first period
  const firstPayDay = payDates[0].date;

  // Assign all bills to periods
  plannerBills.forEach(b => {
    const dueDay = Math.min(b.dueDay, daysInMonth);
    let assigned = false;
    for (let i = 0; i < periods.length; i++) {
      if (dueDay >= periods[i].periodStart && dueDay <= periods[i].periodEnd) {
        periods[i].bills.push(b);
        assigned = true;
        break;
      }
    }
    // Before first paycheck — absorb into first period
    if (!assigned && periods.length) {
      periods[0].bills.push(b);
    }
  });

  periods.forEach(p => p.bills.sort((a, b) => a.dueDay - b.dueDay));

  // ── Step 2: Rebalance across periods
  const getRem = p => p.amount - p.bills.reduce((s, b) => s + b.amount, 0);

  if (periods.length > 1) {
    for (let pass = 0; pass < 20; pass++) {
      const remainings = periods.map(getRem);
      const pctRemaining = remainings.map((r, i) => r / periods[i].amount);

      let worstIdx = 0, bestIdx = 0;
      for (let i = 1; i < periods.length; i++) {
        if (pctRemaining[i] < pctRemaining[worstIdx]) worstIdx = i;
        if (pctRemaining[i] > pctRemaining[bestIdx]) bestIdx = i;
      }

      const spread = pctRemaining[bestIdx] - pctRemaining[worstIdx];
      if (spread < 0.10) break;

      const worstP = periods[worstIdx];
      const bestP = periods[bestIdx];

      let bestMove = null, bestDelta = Infinity;
      for (const b of worstP.bills) {
        const newWorst = remainings[worstIdx] + b.amount;
        const newBest = remainings[bestIdx] - b.amount;
        if (newBest < remainings[worstIdx]) continue;
        const delta = Math.abs(newWorst - newBest);
        if (delta < bestDelta) { bestDelta = delta; bestMove = b; }
      }

      if (!bestMove) break;

      worstP.bills = worstP.bills.filter(b => b !== bestMove);
      bestP.bills.push(bestMove);
      bestP.bills.sort((a, b) => a.dueDay - b.dueDay);
      bestP.movedBills.add(bestMove.id);
    }
  }

  // ── Step 3: Render
  document.getElementById('paycheckList').innerHTML = periods.map((p, idx) => {
    const totalBillAmt = p.bills.reduce((s, b) => s + b.amount, 0);
    const remaining = p.amount - totalBillAmt;
    const remainCls = remaining < 0 ? 'negative' : remaining < p.amount * 0.15 ? 'tight' : 'ok';

    let runningBal = p.amount;
    const billRows = p.bills.map(b => {
      const cat = catInfo(b.category);
      const paid = isPaid(b.id);
      const dueDay = Math.min(b.dueDay, daysInMonth);
      const isMoved = p.movedBills.has(b.id);
      runningBal -= b.amount;
      const runCls = runningBal < 0 ? 'color:var(--expense)' : runningBal < p.amount * 0.15 ? 'color:var(--warn)' : 'color:var(--paid)';
      const moveTag = isMoved ? '<span style="font-size:9px;color:#00d4ff;font-weight:700;margin-left:4px">PAY EARLY</span>' : '';

      return `<div class="pc-bill-row${isMoved ? ' moved' : ''}">
        <div class="pc-bill-icon" style="background:${cat.color}22">${b.icon || cat.icon}</div>
        <div class="pc-bill-name">${escHtml(b.name)}${moveTag}</div>
        <div class="pc-bill-due">Due ${mo} ${dueDay}</div>
        <div class="pc-bill-amount${paid ? ' is-paid' : ''}">${fmt(b.amount)}</div>
      </div>
      <div class="pc-bill-row running-total">
        <div class="pc-running-label">Remaining</div>
        <div class="pc-running-amount" style="${runCls}">${fmt(runningBal)}</div>
      </div>`;
    }).join('');

    const warningHtml = remaining < 0
      ? `<div class="pc-warning">⚠️ Bills exceed this paycheck by ${fmt(Math.abs(remaining))}</div>`
      : '';

    const movedCount = p.movedBills.size;
    const payDateLabel = `${mo} ${p.date}`;
    const periodLabel = `${mo} ${p.periodStart}–${p.periodEnd}`;

    return `<div class="pc-period" id="pc-${idx}">
      <div class="pc-header" onclick="togglePaycheckPeriod(${idx})">
        <div class="pc-check-icon">💵</div>
        <div class="pc-header-info">
          <div class="pc-paycheck-name">${escHtml(p.income.name)} <span style="color:var(--text3);font-weight:500;font-size:11px">— ${payDateLabel}</span></div>
          <div class="pc-paycheck-date">${periodLabel} · ${p.bills.length} bill${p.bills.length !== 1 ? 's' : ''}${movedCount ? ' · ' + movedCount + ' rebalanced' : ''}</div>
        </div>
        <div class="pc-header-right">
          <div class="pc-paycheck-amount">+${fmt(p.amount)}</div>
          <div class="pc-remaining ${remainCls}">Left: ${fmt(remaining)}</div>
        </div>
        <span class="pc-chevron">▼</span>
      </div>
      <div class="pc-bills">
        ${warningHtml}
        ${p.bills.length ? billRows : '<div style="padding:12px;text-align:center;font-size:12px;color:var(--text3)">No bills this period</div>'}
      </div>
    </div>`;
  }).join('');
}

function togglePaycheckPeriod(idx) {
  const el = document.getElementById('pc-' + idx);
  if (!el) return;
  document.querySelectorAll('.pc-period.expanded').forEach(p => {
    if (p !== el) p.classList.remove('expanded');
  });
  el.classList.toggle('expanded');
}

// ═══════════════════════════════════════
//  PLANNER TAB
// ═══════════════════════════════════════
let plannerMonth = new Date().getMonth();
let plannerYear = new Date().getFullYear();
let _plannerView = 'checks';   // 'checks' | 'forecast'
let _forecastOpen = -1;        // expanded forecast month index

function setPlannerView(v) {
  _plannerView = v;
  haptic(5);
  render();
}

function changePlannerMonth(delta) {
  plannerMonth += delta;
  if (plannerMonth > 11) { plannerMonth = 0; plannerYear++; }
  if (plannerMonth < 0) { plannerMonth = 11; plannerYear--; }
  render();
}

// Context handed from renderPlannerTab to the move sheet
let _plannerCtx = null;

// Move a bill from one paycheck period to another — always user-initiated, always undoable
function moveBillToPeriod(billId, fromIdx, toIdx) {
  // Store overrides in state so they persist
  if (!state.plannerOverrides) state.plannerOverrides = {};
  const key = `${plannerYear}-${plannerMonth}`;
  if (!state.plannerOverrides[key]) state.plannerOverrides[key] = {};
  const prev = state.plannerOverrides[key][billId]; // undefined = was in its due-date check
  state.plannerOverrides[key][billId] = toIdx;
  if (!state.plannerOvAt) state.plannerOvAt = {};
  state.plannerOvAt[key] = Date.now();
  saveState();
  closeModal('moveBillModal');
  render();
  haptic(10);
  const name = escHtml(state.bills.find(b => b.id === billId)?.name || 'Bill');
  showToast(`${name} moved`, { undo: () => {
    if (state.plannerOverrides?.[key]) {
      if (prev === undefined) delete state.plannerOverrides[key][billId];
      else state.plannerOverrides[key][billId] = prev;
    }
    saveState();
    render();
  }});
}

// Return a bill to the check its due date puts it in
function clearBillOverride(billId) {
  const key = `${plannerYear}-${plannerMonth}`;
  if (state.plannerOverrides?.[key]) delete state.plannerOverrides[key][billId];
  if (!state.plannerOvAt) state.plannerOvAt = {};
  state.plannerOvAt[key] = Date.now();
  saveState();
  closeModal('moveBillModal');
  render();
  showToast('Returned to due-date check');
}

function clearPlannerOverrides() {
  if (!state.plannerOverrides) return;
  const key = `${plannerYear}-${plannerMonth}`;
  delete state.plannerOverrides[key];
  if (!state.plannerOvAt) state.plannerOvAt = {};
  state.plannerOvAt[key] = Date.now();
  saveState();
  render();
  showToast('All bills back on due-date checks');
}

// Dismiss a suggested move for this session
function dismissSuggestion(billId) {
  const dismissed = JSON.parse(sessionStorage.getItem('sl_sug_dismissed') || '{}');
  dismissed[`${plannerYear}-${plannerMonth}_${billId}`] = true;
  sessionStorage.setItem('sl_sug_dismissed', JSON.stringify(dismissed));
  render();
}

// Bottom sheet: pick which check pays this bill
function openMoveBillSheet(billId, curIdx) {
  const ctx = _plannerCtx;
  if (!ctx || !ctx.bills[billId]) return;
  const bill = ctx.bills[billId];
  const mo = SHORT_MONTHS[plannerMonth];
  document.getElementById('moveBillTitle').textContent = `Pay "${ctx.bills[billId].name}" from…`;
  const options = ctx.periods.filter(p => p.idx !== curIdx).map(p => `
    <button class="move-opt" onclick="moveBillToPeriod('${billId}',${curIdx},${p.idx})">
      <span class="move-opt-name">💵 ${escHtml(p.name)} — ${mo} ${p.date}</span>
      <span class="move-opt-rem ${p.remaining < 0 ? 'neg' : ''}">${fmt(p.remaining)} left</span>
    </button>`).join('');
  const resetOpt = bill.overridden
    ? `<button class="move-opt move-opt-reset" onclick="clearBillOverride('${billId}')">↺ Return to due-date check</button>` : '';
  document.getElementById('moveBillOptions').innerHTML = options + resetOpt +
    `<button class="btn-primary" style="background:var(--surface2);color:var(--text);margin-top:8px" onclick="closeModal('moveBillModal')">Cancel</button>`;
  openModal('moveBillModal');
}

// ── 12-month Forecast (Chronicle pattern): what's due each month, a year out
function computeMonthForecast(m, y) {
  const dim = new Date(y, m + 1, 0).getDate();
  const bills = state.bills.filter(b => isDueThisMonth(b, m, y))
    .map(b => ({ name: b.name, day: Math.min(b.dueDay, dim), amount: b.amount, icon: b.icon || catInfo(b.category).icon }))
    .sort((a, b) => a.day - b.day);
  let billTotal = bills.reduce((s, b) => s + b.amount, 0);

  // Savings auto-deposits: monthly recur; weekly/biweekly counted arithmetically from contribStart
  let savTotal = 0, savCount = 0;
  const first = new Date(y, m, 1), last = new Date(y, m, dim);
  (state.savingsAccounts || []).filter(a => a.contrib > 0).forEach(a => {
    const freq = a.contribFreq || 'monthly';
    if (freq === 'monthly') { savTotal += a.contrib; savCount++; return; }
    if (!a.contribStart) return;
    const interval = (freq === 'biweekly' ? 14 : 7) * 86400000;
    const start = new Date(a.contribStart + 'T00:00:00');
    if (start > last) return;
    // first occurrence on/after the 1st of this month
    let t = start.getTime();
    if (t < first.getTime()) t += Math.ceil((first.getTime() - t) / interval) * interval;
    for (; t <= last.getTime(); t += interval) { savTotal += a.contrib; savCount++; }
  });

  // Income: bucket computed pay dates into this month
  let incTotal = 0, incCount = 0;
  state.incomes.forEach(inc => {
    getNextPayDates(inc, 54).forEach(dt => {
      if (dt.getMonth() === m && dt.getFullYear() === y) { incTotal += inc.amount; incCount++; }
    });
  });

  return { bills, billTotal, savTotal, savCount, incTotal, incCount, total: billTotal + savTotal };
}

function renderForecast() {
  const now = new Date();
  document.querySelector('.planner-month-nav').style.display = 'none';

  let grand = 0, rows = '';
  const data = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    data.push({ m: d.getMonth(), y: d.getFullYear(), f: computeMonthForecast(d.getMonth(), d.getFullYear()) });
    grand += data[i].f.total;
  }

  document.getElementById('plannerForecast').innerHTML = `
    <div class="pl-hero">
      <div class="pl-hero-label">Next 12 Months of Bills</div>
      <div class="pl-hero-amount pl-hero-ok">${fmtHero(grand)}</div>
      <div class="pl-hero-sub">avg ${fmt(grand / 12)}/month · tap a month for the breakdown</div>
    </div>`;

  rows = data.map(({ m, y, f }, i) => {
    const net = f.incTotal - f.total;
    const netCls = net < 0 ? 'neg' : 'pos';
    const open = _forecastOpen === i;
    const detail = !open ? '' : `<div class="fc-detail">
      ${f.bills.map(b => `<div class="fc-bill"><span class="fc-bill-icon">${b.icon}</span><span class="fc-bill-name">${escHtml(b.name)}</span><span class="fc-bill-day">${SHORT_MONTHS[m]} ${b.day}</span><span class="fc-bill-amt">${fmt(b.amount)}</span></div>`).join('') || '<div class="fc-none">No bills due</div>'}
      ${f.savCount ? `<div class="fc-bill"><span class="fc-bill-icon">💰</span><span class="fc-bill-name">Savings deposits ×${f.savCount}</span><span class="fc-bill-day"></span><span class="fc-bill-amt">${fmt(f.savTotal)}</span></div>` : ''}
      ${f.incCount ? `<div class="fc-bill fc-inc"><span class="fc-bill-icon">💵</span><span class="fc-bill-name">${f.incCount} paycheck${f.incCount > 1 ? 's' : ''}</span><span class="fc-bill-day"></span><span class="fc-bill-amt">+${fmt(f.incTotal)}</span></div>` : ''}
    </div>`;
    return `<div class="fc-row${open ? ' open' : ''}" onclick="_forecastOpen=_forecastOpen===${i}?-1:${i};render()">
      <div class="fc-row-top">
        <span class="fc-month">${MONTHS[m]}${m === 0 || i === 0 ? ` ${y}` : ''}</span>
        <span class="fc-bills">${fmt(f.total)}</span>
        <span class="fc-net ${netCls}">${net >= 0 ? '+' : '−'}${fmtShort(Math.abs(net))}</span>
        <span class="fc-chev">${open ? '▾' : '▸'}</span>
      </div>
      ${detail}
    </div>`;
  }).join('');

  document.getElementById('plannerPeriods').innerHTML =
    `<div class="fc-legend"><span>Month</span><span>Bills out</span><span>Net after income</span></div>` + rows;
}

function renderPlannerTab() {
  const y = plannerYear, m = plannerMonth;
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const mo = SHORT_MONTHS[m];

  // Segmented view toggle: paycheck allocation vs 12-month forecast
  let seg = document.getElementById('plannerSeg');
  if (!seg) {
    seg = document.createElement('div');
    seg.id = 'plannerSeg';
    seg.className = 'seg-toggle';
    document.getElementById('plannerForecast').before(seg);
  }
  seg.innerHTML = `
    <button class="seg-btn${_plannerView === 'checks' ? ' active' : ''}" onclick="setPlannerView('checks')">Paychecks</button>
    <button class="seg-btn${_plannerView === 'forecast' ? ' active' : ''}" onclick="setPlannerView('forecast')">Forecast</button>`;

  if (_plannerView === 'forecast') { renderForecast(); return; }
  document.querySelector('.planner-month-nav').style.display = '';

  document.getElementById('plannerMonthLabel').textContent = `${MONTHS[m]} ${y}`;

  const plannerBills = state.bills.concat(getSavingsContribBills())
    .filter(b => !b.excludeFromPlanner && isDueThisMonth(b, m, y));
  const plannerIncomes = state.incomes.filter(inc => !inc.excludeFromPlanner);

  // Gather paychecks for this month
  let payDates = [];
  plannerIncomes.forEach(inc => {
    getNextPayDates(inc, 12).forEach(dt => {
      if (dt.getMonth() === m && dt.getFullYear() === y) {
        payDates.push({ date: dt.getDate(), income: inc, amount: inc.amount, dt });
      }
    });
  });
  payDates.sort((a, b) => a.date - b.date);

  // Cross-month pay periods: a check late in the month must also carry the
  // early-next-month bills due before the NEXT check lands. Likewise, bills due
  // before this month's first check belong to LAST month's final check.
  const nm = m === 11 ? 0 : m + 1, ny = m === 11 ? y + 1 : y;
  const pmm = m === 0 ? 11 : m - 1, pyy = m === 0 ? y - 1 : y;
  const payDaysIn = (mm, yy) => {
    const sm2 = state.currentMonth, sy2 = state.currentYear;
    state.currentMonth = mm; state.currentYear = yy; // getNextPayDates anchors on the viewed month
    const days = [];
    plannerIncomes.forEach(inc => getNextPayDates(inc, 12).forEach(dt => {
      if (dt.getMonth() === mm && dt.getFullYear() === yy) days.push(dt.getDate());
    }));
    state.currentMonth = sm2; state.currentYear = sy2;
    return days;
  };
  const nmDays = payDaysIn(nm, ny);
  const nextMonthFirstPay = nmDays.length ? Math.min(...nmDays) : null;
  const pmDays = payDaysIn(pmm, pyy);
  const prevMonthLastPay = pmDays.length ? Math.max(...pmDays) : null;

  // Empty state
  if (!payDates.length) {
    document.getElementById('plannerForecast').innerHTML = '';
    document.getElementById('plannerPeriods').innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-icon">📊</div>${plannerIncomes.length === 0 && state.incomes.length > 0 ? 'All income excluded from planner.<br><span style="font-size:11px;color:var(--text3)">Edit an income source to include it.</span>' : 'Add income sources to plan your paychecks<br><button class="empty-cta" onclick="openIncomeModal()">＋ Add Income</button>'}</div>`;
    return;
  }

  // Build periods
  const periods = payDates.map((pd, i) => {
    const periodStart = pd.date;
    const periodEnd = i < payDates.length - 1 ? payDates[i+1].date - 1 : daysInMonth;
    return { ...pd, periodStart, periodEnd, bills: [], movedBills: new Set() };
  });

  // The month's final check stretches into next month, up to the day before its first check
  const lastP = periods[periods.length - 1];
  if (nextMonthFirstPay && nextMonthFirstPay > 1) lastP.spillEnd = nextMonthFirstPay - 1;

  // Get overrides for this month
  const overrideKey = `${y}-${m}`;
  const overrides = (state.plannerOverrides && state.plannerOverrides[overrideKey]) || {};
  const hasOverrides = Object.keys(overrides).length > 0;

  // Assign bills to periods (respecting overrides). Bills due before the first
  // check are covered by last month's final paycheck — don't double-plan them.
  const firstPayDay = periods[0].periodStart;
  const preFirst = [];
  plannerBills.forEach(b => {
    if (overrides[b.id] !== undefined) {
      const targetIdx = overrides[b.id];
      if (targetIdx >= 0 && targetIdx < periods.length) {
        periods[targetIdx].bills.push(b);
        periods[targetIdx].movedBills.add(b.id);
        return;
      }
    }
    const dueDay = Math.min(b.dueDay, daysInMonth);
    if (dueDay < firstPayDay && prevMonthLastPay) { preFirst.push(b); return; }
    let assigned = false;
    for (let i = 0; i < periods.length; i++) {
      if (dueDay >= periods[i].periodStart && dueDay <= periods[i].periodEnd) {
        periods[i].bills.push(b);
        assigned = true;
        break;
      }
    }
    if (!assigned && periods.length) periods[0].bills.push(b);
  });

  // Borrow early-next-month bills into the final check — its true coverage window
  if (lastP.spillEnd) {
    const ndim = new Date(ny, nm + 1, 0).getDate();
    const nextOverrides = (state.plannerOverrides && state.plannerOverrides[`${ny}-${nm}`]) || {};
    state.bills.concat(getSavingsContribBills())
      .filter(b => !b.excludeFromPlanner && isDueThisMonth(b, nm, ny))
      .forEach(b => {
        if (nextOverrides[b.id] !== undefined) return; // user manages it in next month's view
        const dd = Math.min(b.dueDay, ndim);
        if (dd <= lastP.spillEnd) lastP.bills.push({ ...b, _borrowed: true, _pMonth: nm, _pYear: ny, _pDay: dd });
      });
  }

  // Sort by effective due date — borrowed next-month bills come after month-end ones
  periods.forEach(p => p.bills.sort((a, b) =>
    (a._borrowed ? a._pDay + 100 : a.dueDay) - (b._borrowed ? b._pDay + 100 : b.dueDay)));

  // NO silent rebalancing — assignment is due-date rule + explicit user moves only.
  // Per-period money math with paid-state (the "in → paid → owed → left" rollup)
  periods.forEach(p => {
    p.totalBills = p.bills.reduce((s, b) => s + b.amount, 0);
    p.paidAmt = p.bills.filter(b => isPaid(b.id, b._pMonth ?? m, b._pYear ?? y))
      .reduce((s, b) => s + (getPaidAmount(b.id, b._pMonth ?? m, b._pYear ?? y) ?? b.amount), 0);
    p.owedAmt = p.bills.filter(b => !isPaid(b.id, b._pMonth ?? m, b._pYear ?? y)).reduce((s, b) => s + b.amount, 0);
    p.remaining = p.amount - p.totalBills;
  });

  // Suggestion (consent-based): if a check is short, propose ONE move the user can accept or dismiss
  let suggestion = null;
  if (periods.length > 1) {
    const dismissed = JSON.parse(sessionStorage.getItem('sl_sug_dismissed') || '{}');
    const shortIdx = periods.findIndex(p => p.remaining < 0);
    if (shortIdx >= 0) {
      let bestIdx = -1;
      periods.forEach((p, i) => {
        if (i !== shortIdx && (bestIdx < 0 || p.remaining > periods[bestIdx].remaining)) bestIdx = i;
      });
      if (bestIdx >= 0 && periods[bestIdx].remaining > 0) {
        // Largest unpaid, unmoved bill that fits in the healthiest check
        const cands = periods[shortIdx].bills
          .filter(b => overrides[b.id] === undefined && !b._borrowed && !isPaid(b.id, m, y) && !b._isSavingsContrib
            && b.amount <= periods[bestIdx].remaining && !dismissed[`${overrideKey}_${b.id}`])
          .sort((a, b) => b.amount - a.amount);
        if (cands.length) suggestion = { bill: cands[0], fromIdx: shortIdx, toIdx: bestIdx };
      }
    }
  }

  // Context for the tap-to-move sheet
  _plannerCtx = {
    overrideKey,
    periods: periods.map((p, i) => ({ idx: i, name: p.income.name, date: p.date, remaining: p.remaining })),
    bills: Object.fromEntries(plannerBills.map(b => [b.id, { name: b.name, overridden: overrides[b.id] !== undefined }])),
  };

  // ── Compute totals — the month strip stays calendar-month honest (all bills due
  // this month, regardless of which check pays them)
  const totalIncome = periods.reduce((s, p) => s + p.amount, 0);
  const totalBills = plannerBills.reduce((s, b) => s + b.amount, 0);
  const monthLeft = totalIncome - totalBills;

  // ── Hero: per-check safe-to-spend when viewing the current pay period, month rollup otherwise
  const today = new Date();
  const isCurMonth = today.getFullYear() === y && today.getMonth() === m;
  const curIdx = isCurMonth
    ? periods.findIndex(p => today.getDate() >= p.periodStart && today.getDate() <= p.periodEnd)
    : -1;

  let heroLabel, heroAmt, heroSub;
  if (curIdx >= 0) {
    const cp = periods[curIdx];
    const nextP = periods[curIdx + 1];
    heroLabel = 'Left to Spend This Check';
    heroAmt = cp.remaining;
    heroSub = `${escHtml(cp.income.name)} · ${mo} ${cp.date} check · ${nextP ? `until ${mo} ${nextP.date}` : cp.spillEnd ? `until ${SHORT_MONTHS[nm]} ${nextMonthFirstPay}` : `through end of ${mo}`}`;
  } else {
    heroLabel = `Uncommitted in ${MONTHS[m]}`;
    heroAmt = monthLeft;
    heroSub = 'after all planned bills';
  }
  const availCls = heroAmt < 0 ? 'pl-hero-neg' : heroAmt < totalIncome * 0.08 ? 'pl-hero-tight' : 'pl-hero-ok';

  // Consent-based suggestion banner (replaces the old silent rebalancer)
  let suggestHtml = '';
  if (suggestion) {
    const sp = periods[suggestion.fromIdx], tp = periods[suggestion.toIdx];
    suggestHtml = `<div class="pl-suggest">
      <div class="pl-suggest-text">⚠️ The <b>${mo} ${sp.date}</b> check is short <b>${fmt(Math.abs(sp.remaining))}</b>. Move <b>${escHtml(suggestion.bill.name)}</b> (${fmt(suggestion.bill.amount)}) to the ${mo} ${tp.date} check?</div>
      <div class="pl-suggest-actions">
        <button class="pl-suggest-yes" onclick="moveBillToPeriod('${suggestion.bill.id}',${suggestion.fromIdx},${suggestion.toIdx})">Move it</button>
        <button class="pl-suggest-no" onclick="dismissSuggestion('${suggestion.bill.id}')">Dismiss</button>
      </div>
    </div>`;
  }

  document.getElementById('plannerForecast').innerHTML = `
    <div class="pl-hero">
      <div class="pl-hero-label">${heroLabel}</div>
      <div class="pl-hero-amount ${availCls}">${fmtHero(heroAmt)}</div>
      <div class="pl-hero-sub">${heroSub}</div>
    </div>
    <div class="pl-month-strip">
      <span class="pl-hero-inc">${fmt(totalIncome)} in</span>
      <span class="pl-hero-op">−</span>
      <span class="pl-hero-exp">${fmt(totalBills)} bills</span>
      <span class="pl-hero-op">=</span>
      <span class="${monthLeft < 0 ? 'pl-hero-exp' : 'pl-hero-inc'}">${fmt(monthLeft)} this month</span>
      ${hasOverrides ? '<button class="pl-reset-btn" onclick="clearPlannerOverrides()">↺ Reset moves</button>' : ''}
    </div>
    ${suggestHtml}`;

  // Animate the hero amount when it changes (count-up/down)
  animateAmount(document.querySelector('.pl-hero-amount'), window._plHeroPrev, heroAmt);
  window._plHeroPrev = heroAmt;

  // ── Paycheck cards: in → paid → owed → left, tap a bill to move it
  // Bills due before the first check — already covered by last month's final paycheck
  const preFirstHtml = preFirst.length
    ? `<div class="pl-prefirst">✓ ${preFirst.length} bill${preFirst.length > 1 ? 's' : ''} due ${mo} 1–${firstPayDay - 1} (${fmt(preFirst.reduce((s, b) => s + b.amount, 0))}) covered by your ${SHORT_MONTHS[pmm]} ${prevMonthLastPay} check</div>`
    : '';

  document.getElementById('plannerPeriods').innerHTML = preFirstHtml + periods.map((p, idx) => {
    const isCurrent = idx === curIdx;
    const remaining = p.remaining;
    const paidPct = p.amount > 0 ? Math.min((p.paidAmt / p.amount) * 100, 100) : 0;
    const owedPct = p.amount > 0 ? Math.min((p.owedAmt / p.amount) * 100, 100 - paidPct) : 0;
    const healthCls = remaining < 0 ? 'pc-health-neg' : (p.totalBills / p.amount) > 0.85 ? 'pc-health-tight' : 'pc-health-ok';

    const billRows = p.bills.map(b => {
      const cat = catInfo(b.category);
      const bm = b._pMonth ?? m, by = b._pYear ?? y;
      const paid = isPaid(b.id, bm, by);
      const dueDay = b._borrowed ? b._pDay : Math.min(b.dueDay, daysInMonth);
      const isMoved = p.movedBills.has(b.id);
      const canMove = !b._isSavingsContrib && periods.length > 1 && !b._borrowed;

      return `<div class="pl-bill${paid ? ' pl-paid' : ''}${isMoved ? ' pl-moved' : ''}${canMove ? ' pl-movable' : ''}"${canMove ? ` onclick="openMoveBillSheet('${b.id}',${idx})"` : ''}>
        <span class="pl-bill-icon" style="background:${cat.color}22">${paid ? '✓' : (b.icon || cat.icon)}</span>
        <span class="pl-bill-name">${escHtml(b.name)}${isMoved ? '<span class="pl-tag">moved by you</span>' : ''}${b._borrowed ? '<span class="pl-tag" style="color:var(--warn);background:var(--warn-soft)">next month</span>' : ''}</span>
        <span class="pl-bill-due">${paid ? 'Paid' : `Due ${SHORT_MONTHS[bm]} ${dueDay}`}</span>
        <span class="pl-bill-amt${paid ? ' pl-paid' : ''}">${fmt(b.amount)}</span>
        ${canMove ? '<span class="pl-move-hint">›</span>' : ''}
      </div>`;
    }).join('');

    const warningHtml = remaining < 0
      ? `<div class="pl-card-warning">⚠️ Bills exceed this check by ${fmt(Math.abs(remaining))} — tap a bill to move it</div>` : '';

    return `<div class="pl-card ${healthCls}${isCurrent ? ' pl-current' : ''}">
      ${isCurrent ? '<div class="pl-now-badge">CURRENT CHECK</div>' : ''}
      <div class="pl-card-top">
        <div class="pl-card-source">
          <div class="pl-card-name">💵 ${escHtml(p.income.name)}</div>
          <div class="pl-card-date">${mo} ${p.date} · covers ${mo} ${p.periodStart} – ${p.spillEnd ? `${SHORT_MONTHS[nm]} ${p.spillEnd}` : `${mo} ${p.periodEnd}`}</div>
        </div>
        <div class="pl-card-pay">+${fmt(p.amount)}</div>
      </div>
      <div class="pl-card-bar">
        <div class="pl-seg-paid" style="width:${paidPct}%"></div>
        <div class="pl-seg-owed ${healthCls}" style="width:${owedPct}%"></div>
      </div>
      <div class="pl-card-bar-labels">
        <span><span class="pl-lbl-paid">✓ ${fmt(p.paidAmt)} paid</span> · ${fmt(p.owedAmt)} to pay</span>
        <span class="pl-lbl-left ${remaining < 0 ? 'neg' : ''}">${fmt(remaining)} left</span>
      </div>
      ${warningHtml}
      ${p.bills.length ? `<div class="pl-bill-list">${billRows}</div>` : '<div class="pl-empty-bills">No bills come out of this check</div>'}
      <div class="pl-card-footer ${healthCls}">
        <span class="pl-footer-label">Left after all bills</span>
        <span class="pl-footer-amount">${fmt(remaining)}</span>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
//  CASH FLOW RIBBON
//  Day-by-day projected balance for the next 60 days: paychecks spike it,
//  bills notch it, savings deposits drain it. The one chart no bill app has.
// ═══════════════════════════════════════
let _ribbonSeries = null;

function computeCashFlow(days = 60) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const events = {}; // iso date -> [{name, amt}]
  const addEv = (d, name, amt) => {
    const k = d.toISOString().slice(0, 10);
    (events[k] = events[k] || []).push({ name, amt });
  };

  // Incomes — getNextPayDates anchors on the VIEWED month; pin it to real today for the projection
  const sm = state.currentMonth, sy = state.currentYear;
  state.currentMonth = start.getMonth(); state.currentYear = start.getFullYear();
  state.incomes.forEach(inc => {
    getNextPayDates(inc, 54).forEach(dt => {
      const dd = new Date(dt); dd.setHours(0, 0, 0, 0);
      const diff = (dd - start) / 86400000;
      if (diff >= 0 && diff < days) addEv(dd, inc.name, inc.amount);
    });
  });
  state.currentMonth = sm; state.currentYear = sy;

  // Bills + monthly savings deposits across the window's months
  [0, 1, 2].forEach(off => {
    const base = new Date(start.getFullYear(), start.getMonth() + off, 1);
    const m = base.getMonth(), y = base.getFullYear();
    const dim = new Date(y, m + 1, 0).getDate();
    state.bills.filter(b => isDueThisMonth(b, m, y)).forEach(b => {
      if (isPaid(b.id, m, y)) return; // already left the account
      const dd = new Date(y, m, Math.min(b.dueDay, dim));
      const diff = (dd - start) / 86400000;
      if (diff >= 0 && diff < days) addEv(dd, b.name, -b.amount);
    });
    (state.savingsAccounts || []).filter(a => a.contrib > 0 && (a.contribFreq || 'monthly') === 'monthly').forEach(a => {
      const dd = new Date(y, m, Math.min(a.contribDay || 1, dim));
      const diff = (dd - start) / 86400000;
      if (diff >= 0 && diff < days) addEv(dd, a.name + ' deposit', -a.contrib);
    });
  });
  // Weekly/biweekly savings deposits
  (state.savingsAccounts || []).filter(a => a.contrib > 0 && (a.contribFreq === 'weekly' || a.contribFreq === 'biweekly')).forEach(a => {
    if (!a.contribStart) return;
    const interval = (a.contribFreq === 'biweekly' ? 14 : 7) * 86400000;
    let t = new Date(a.contribStart + 'T00:00:00').getTime();
    const endT = start.getTime() + days * 86400000;
    if (t < start.getTime()) t += Math.ceil((start.getTime() - t) / interval) * interval;
    for (; t < endT; t += interval) addEv(new Date(t), a.name + ' deposit', -a.contrib);
  });

  // Accumulate from the anchor (or 0 for relative mode)
  let bal = state.cashAnchor ? state.cashAnchor.amount : 0;
  const series = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const k = d.toISOString().slice(0, 10);
    (events[k] || []).forEach(e => bal += e.amt);
    series.push({ d, bal, events: events[k] || [] });
  }
  return series;
}

function renderCashRibbon() {
  const zone = document.getElementById('zone-ribbon');
  if (!zone) return;
  if (!state.bills.length && !state.incomes.length) { zone.style.display = 'none'; return; }
  zone.style.display = '';

  const s = computeCashFlow(60);
  _ribbonSeries = s;
  const W = 360, H = 120, PT = 14, PB = 20, PL = 8, PR = 8;
  const vals = s.map(p => p.bal);
  let mn = Math.min(0, ...vals), mx = Math.max(0, ...vals);
  if (mx === mn) mx = mn + 1;
  const y = v => PT + (mx - v) / (mx - mn) * (H - PT - PB);
  const x = i => PL + i * (W - PL - PR) / (s.length - 1);

  // Step-after path — cash moves in steps, not slopes; the honest shape
  let line = `M${x(0)},${y(s[0].bal).toFixed(1)}`;
  for (let i = 1; i < s.length; i++) {
    line += `L${x(i).toFixed(1)},${y(s[i-1].bal).toFixed(1)}L${x(i).toFixed(1)},${y(s[i].bal).toFixed(1)}`;
  }
  const area = line + `L${x(s.length-1).toFixed(1)},${H-PB}L${x(0)},${H-PB}Z`;
  const yz = y(0);

  const dots = s.map((p, i) => p.events.some(e => e.amt > 0)
    ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.bal).toFixed(1)}" r="3" fill="#2dd4a8" stroke="#0f0f14" stroke-width="1"/>` : '').join('');
  const minI = vals.indexOf(Math.min(...vals));
  const minP = s[minI];
  const ticks = s.map((p, i) => p.d.getDate() === 1
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="8" fill="#55556a" text-anchor="middle">${SHORT_MONTHS[p.d.getMonth()]}</text>` : '').join('');

  const lowPill = minP.bal < 0
    ? `<div class="ribbon-warn" onclick="switchTab('planner')">⚠️ Dips ${fmt(Math.abs(minP.bal))} below zero around ${SHORT_MONTHS[minP.d.getMonth()]} ${minP.d.getDate()} — open the Planner to move a bill →</div>`
    : '';

  const anchor = state.cashAnchor;
  const btn = document.getElementById('ribbonAnchorBtn');
  if (btn) btn.textContent = anchor ? `from ${fmtShort(anchor.amount)} · edit` : 'Set balance';

  document.getElementById('cashRibbon').innerHTML = `
    <div class="ribbon-card" onpointerdown="ribbonScrub(event)" onpointermove="if(event.buttons||event.pointerType==='touch')ribbonScrub(event)">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:130px;display:block">
        <defs>
          <linearGradient id="rgA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(45,212,168,.32)"/><stop offset="1" stop-color="rgba(45,212,168,0)"/>
          </linearGradient>
          <clipPath id="cpA"><rect x="0" y="0" width="${W}" height="${yz.toFixed(1)}"/></clipPath>
          <clipPath id="cpB"><rect x="0" y="${yz.toFixed(1)}" width="${W}" height="${(H - yz).toFixed(1)}"/></clipPath>
        </defs>
        <line x1="0" y1="${yz.toFixed(1)}" x2="${W}" y2="${yz.toFixed(1)}" stroke="rgba(255,255,255,.14)" stroke-dasharray="3 4"/>
        <path d="${area}" fill="url(#rgA)" clip-path="url(#cpA)"/>
        <path d="${area}" fill="rgba(248,113,113,.22)" clip-path="url(#cpB)"/>
        <path d="${line}" fill="none" stroke="#2dd4a8" stroke-width="2" clip-path="url(#cpA)"/>
        <path d="${line}" fill="none" stroke="#f87171" stroke-width="2" clip-path="url(#cpB)"/>
        ${dots}
        <circle cx="${x(minI).toFixed(1)}" cy="${y(minP.bal).toFixed(1)}" r="3.5" fill="${minP.bal < 0 ? '#f87171' : '#e8b500'}" stroke="#0f0f14" stroke-width="1.5"/>
        ${ticks}
        <line id="ribbonCursor" x1="-10" y1="${PT}" x2="-10" y2="${H - PB}" stroke="rgba(59,130,246,.85)"/>
      </svg>
      <div class="ribbon-tip" id="ribbonTip">${anchor ? 'Drag to explore your next 60 days' : 'Drag to explore · relative flow — set a balance for real numbers'}</div>
      ${lowPill}
    </div>`;
}

function ribbonScrub(e) {
  if (!_ribbonSeries) return;
  const svg = e.currentTarget.querySelector('svg');
  const r = svg.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const i = Math.round(frac * (_ribbonSeries.length - 1));
  const p = _ribbonSeries[i];
  const cx = 8 + i * (360 - 16) / (_ribbonSeries.length - 1);
  const cur = svg.querySelector('#ribbonCursor');
  cur.setAttribute('x1', cx); cur.setAttribute('x2', cx);
  const evs = p.events.slice(0, 2).map(ev => `${ev.amt > 0 ? '+' : '−'}${fmtShort(Math.abs(ev.amt))} ${escHtml(ev.name)}`).join(' · ');
  document.getElementById('ribbonTip').innerHTML =
    `<b>${SHORT_MONTHS[p.d.getMonth()]} ${p.d.getDate()}</b> — <b style="color:${p.bal < 0 ? 'var(--expense)' : 'var(--paid)'}">${fmt(p.bal)}</b>${evs ? ' · ' + evs : ''}`;
}

function openCashModal() {
  document.getElementById('cashInput').value = state.cashAnchor ? state.cashAnchor.amount : '';
  openModal('cashModal');
  focusField('cashInput');
}

function saveCashAnchor() {
  const v = parseFloat(document.getElementById('cashInput').value);
  state.cashAnchor = isNaN(v) ? null : { amount: v, asOf: new Date().toISOString().slice(0, 10) };
  saveState();
  closeModal('cashModal');
  render();
  if (!isNaN(v)) showToast('✓ Cash flow anchored to your balance');
}

// ── Bills tab
function renderBills(monthBills) {
  // Category filter tabs
  const usedCats = [...new Set(monthBills.map(b => b.category))];
  const cats = getCats().filter(c => usedCats.includes(c.id));
  const filterCat = _activeFilter || 'all';

  document.getElementById('filterTabs').innerHTML = `
    <button class="filter-tab${filterCat === 'all' ? ' active' : ''}" onclick="setFilter('all')">All</button>
    ${cats.map(c => `<button class="filter-tab${filterCat === c.id ? ' active' : ''}" onclick="setFilter('${c.id}')">${c.icon} ${c.label}</button>`).join('')}
  `;

  const filtered = filterCat === 'all' ? monthBills : monthBills.filter(b => b.category === filterCat);

  // Bucket bills into sections: Overdue → Due Today → Upcoming → Paid
  const overdue = [], dueToday = [], upcoming = [], paid = [];
  filtered.forEach(b => {
    if (isPaid(b.id)) { paid.push(b); return; }
    const du = daysUntil(getDueDate(b));
    if (du < 0) overdue.push(b);
    else if (du === 0) dueToday.push(b);
    else upcoming.push(b);
  });
  // Sort each bucket by due day
  [overdue, dueToday, upcoming, paid].forEach(arr => arr.sort((a, b) => a.dueDay - b.dueDay));

  if (!filtered.length) {
    document.getElementById('billList').innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>No bills this month<br><button class="empty-cta" onclick="openBillModal()">＋ Add a Bill</button></div>';
    return;
  }

  // Build section HTML with headers
  const sections = [];
  if (overdue.length) sections.push({ label: `Overdue · ${overdue.length}`, cls: 'overdue', bills: overdue });
  if (dueToday.length) sections.push({ label: `Due Today · ${dueToday.length}`, cls: 'today', bills: dueToday });
  if (upcoming.length) sections.push({ label: `Upcoming · ${upcoming.length}`, cls: 'upcoming', bills: upcoming });
  if (paid.length) sections.push({ label: `Paid · ${paid.length}`, cls: 'paid', bills: paid });

  document.getElementById('billList').innerHTML = sections.map(sec =>
    `<div class="bill-section ${sec.cls}"><div class="bill-section-hdr">${sec.label}</div>${sec.bills.map(b => renderBillCard(b)).join('')}</div>`
  ).join('');
}

function renderBillCard(b) {
  const paid = isPaid(b.id);
  const cat = catInfo(b.category);
  const dueStr = getDueDate(b);
  const du = daysUntil(dueStr);
  let meta = `Due ${SHORT_MONTHS[state.currentMonth]} ${b.dueDay}`;
  const payRec = paid ? state.payments.find(p => p.billId === b.id && p.month === state.currentMonth && p.year === state.currentYear) : null;
  if (paid) meta = payRec?.auto ? 'Paid automatically' : 'Paid';
  else if (du < 0) meta = `${Math.abs(du)}d overdue`;
  else if (du === 0) meta = 'Due today';
  else if (du === 1) meta = 'Due tomorrow';

  // Variable-bill estimate (Chronicle pattern): average of recent adjusted payments
  if (!paid) {
    const hist = state.payments.filter(p => p.billId === b.id && p.paidAmount != null && p.paidAmount !== b.amount).slice(-3);
    if (hist.length >= 2) {
      const est = hist.reduce((s, p) => s + p.paidAmount, 0) / hist.length;
      meta += ` · usually ~${fmtShort(est)}`;
    } else if (b.frequency === 'quarterly' || b.frequency === 'yearly') {
      // Amount-to-save (Chronicle): pro-rate lumpy bills into a monthly set-aside
      meta += ` · set aside ${fmtShort(b.amount / (b.frequency === 'quarterly' ? 3 : 12))}/mo`;
    }
  }

  const isSav = b._isSavingsContrib;
  const paidAmt = paid ? getPaidAmount(b.id) : null;
  const paidDiff = (paidAmt !== null && paidAmt !== b.amount) ? `<div style="font-size:10px;color:var(--paid);font-weight:700">paid ${fmt(paidAmt)}</div>` : '';

  // Savings: meta shows auto status, no pay button, no actions
  if (isSav) {
    const savMeta = paid ? '✓ Auto-deposited' : `Auto-deposits ${SHORT_MONTHS[state.currentMonth]} ${b.dueDay}`;
    return `<div class="bill-card${paid ? ' is-paid' : ''} is-savings" id="bc-${b.id}">
      <div class="bc-main">
        <div class="bc-icon" style="background:${cat.color}22">${b.icon || cat.icon}</div>
        <div class="bc-info"><div class="bc-name${paid ? ' struck' : ''}">${escHtml(b.name)}</div><div class="bc-meta">${savMeta}</div></div>
        <div class="bc-right"><div class="bc-amount" style="color:${paid ? 'var(--paid)' : 'var(--text)'}">${fmt(b.amount)}</div></div>
      </div>
    </div>`;
  }

  // Regular bills: tap card → payment history, quick-action icons inline
  const quickActions = `<div class="bc-quick">
    ${b.payUrl ? `<button class="bc-qbtn" onclick="event.stopPropagation();openPayUrl('${b.id}')" title="Pay online">🔗</button>` : ''}
    <button class="bc-qbtn" onclick="event.stopPropagation();openBillModal('${b.id}')" title="Edit">✏️</button>
    <button class="bc-qbtn" onclick="event.stopPropagation();cloneBill('${b.id}')" title="Duplicate">📋</button>
    <button class="bc-qbtn" onclick="event.stopPropagation();deleteBillDirect('${b.id}')" title="Delete">🗑️</button>
  </div>`;

  return `<div class="bill-card${paid ? ' is-paid' : ''}" id="bc-${b.id}">
    <div class="bc-main" onclick="openPayeeHistory('${b.id}')">
      <button class="bill-pay-btn${paid ? ' is-paid' : ''}" onclick="event.stopPropagation();togglePaid('${b.id}')">${paid ? '✓ Paid' : 'Pay'}</button>
      <div class="bc-icon" style="background:${cat.color}22">${b.icon || cat.icon}</div>
      <div class="bc-info"><div class="bc-name${paid ? ' struck' : ''}">${escHtml(b.name)}</div><div class="bc-meta">${meta}${b.payMethod === 'autopay' ? ' · Autopay' : ''}${b.excludeFromPlanner ? ' · <span style="color:var(--text3);font-style:italic">Not in planner</span>' : ''}</div></div>
      <div class="bc-right"><div class="bc-amount" style="color:${paid ? 'var(--paid)' : 'var(--text)'}">${fmt(b.amount)}</div>${paidDiff}</div>
      ${quickActions}
    </div>
  </div>`;
}

// Filter persists across renders via module-level var (not saved to localStorage)
let _activeFilter = 'all';
function setFilter(cat) {
  _activeFilter = cat;
  render();
}

// Legacy — kept for compatibility if referenced elsewhere
function toggleBillExpand(billId) { openPayeeHistory(billId); }

// ── Income tab
function renderIncomeTab() {
  const FREQ_LABELS = { monthly: "Monthly", biweekly: "Bi-Weekly", weekly: "Weekly", yearly: "Yearly" };

  if (!state.incomes.length) {
    document.getElementById('incomeList').innerHTML = '<div class="empty-state"><div class="empty-icon">💵</div>No income sources added<br><button class="empty-cta" onclick="openIncomeModal()">＋ Add Income</button></div>';
    return;
  }

  document.getElementById('incomeList').innerHTML = state.incomes.map(inc => {
    const nextDates = getNextPayDates(inc, 1);
    const nextStr = nextDates.length ? nextDates[0].toISOString().slice(0,10) : '';
    const nextLabel = nextStr ? `Next: ${SHORT_MONTHS[new Date(nextStr+'T00:00:00').getMonth()]} ${new Date(nextStr+'T00:00:00').getDate()}` : '';

    return `<div class="income-card" onclick="openIncomeModal('${inc.id}')" style="cursor:pointer">
      <div class="ic-icon">💵</div>
      <div class="ic-info"><div class="ic-name">${escHtml(inc.name)}</div><div class="ic-meta">${FREQ_LABELS[inc.frequency] || inc.frequency}${nextLabel ? ' · ' + nextLabel : ''}${inc.excludeFromPlanner ? ' · <span style="color:var(--text3);font-style:italic">Not in planner</span>' : ''}</div></div>
      <div class="ic-amount">+${fmt(inc.amount)}</div>
    </div>`;
  }).join('');
}

// ── Savings tab
function renderSavings() {
  const accts = state.savingsAccounts || [];
  const container = document.getElementById('savingsList');
  if (!accts.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🏦</div>No savings accounts<br><button class="empty-cta" onclick="openSavingsModal()">＋ Add Account</button></div>';
    return;
  }

  // Compute all balances and total
  const balances = accts.map(a => computedBalance(a.id));
  const total = balances.reduce((s, b) => s + b, 0);

  const freqLabel = f => ({ monthly: '/mo', biweekly: '/2wk', weekly: '/wk' }[f] || '/mo');

  const totalHtml = `<div class="savings-total-bar">
    <span class="savings-total-label">Total Saved</span>
    <span class="savings-total-amount">${fmtHero(total)}</span>
  </div>`;

  const cardsHtml = accts.map((a, i) => {
    const bal = balances[i];
    const goal = a.goal || 0;
    const pct = goal > 0 ? Math.min(100, (bal / goal) * 100) : 0;
    const contribInfo = a.contrib ? `<div class="sav-autodeposit">💰 Auto-deposit: ${fmt(a.contrib)}${freqLabel(a.contribFreq)} on day ${a.contribDay || 1}${a.contribStart ? ' · since ' + a.contribStart : ''}</div>` : '';
    // HYSA interest line: APY + estimated monthly interest at the current balance
    const apyInfo = a.apy > 0
      ? `<div class="sav-autodeposit">📈 ${a.apy}% APY · ≈ +${fmt(bal * (Math.pow(1 + a.apy / 100, 1 / 12) - 1))}/mo interest</div>` : '';

    return `<div class="savings-card" onclick="openSavingsModal('${a.id}')" style="margin-bottom:8px;cursor:pointer">
      <div class="sav-header">
        <div><div class="sav-name">${escHtml(a.name)}</div><div class="sav-type">${a.type || 'Savings'}</div></div>
        <div style="text-align:right">
          <div class="sav-balance">${fmt(bal)}</div>
          <div class="sav-edit-hint">tap to edit</div>
        </div>
      </div>
      ${goal > 0 ? `<div class="sav-progress"><div class="sav-progress-fill" style="width:${pct}%"></div></div>
      <div class="sav-goal"><span>${pct.toFixed(0)}% of goal</span><span>${fmt(goal)}</span></div>` : ''}
      ${contribInfo}
      ${apyInfo}
    </div>`;
  }).join('');

  container.innerHTML = totalHtml + cardsHtml;
}

// ═══════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// Focus the first field when adding (not editing — avoids keyboard pop on review)
function focusField(inputId) {
  setTimeout(() => document.getElementById(inputId)?.focus(), 280); // after sheet slide-in
}

// Enter in any modal input saves — maps modal → save action
const MODAL_SAVE = {
  billModal: () => saveBill(),
  incomeModal: () => saveIncome(),
  savingsModal: () => saveSavingsAccount(),
  payAmtModal: () => document.getElementById('payAmtSaveBtn')?.click(),
  cashModal: () => saveCashAnchor(),
};
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
  const overlay = e.target.closest('.modal-overlay');
  const save = overlay && MODAL_SAVE[overlay.id];
  if (save) { e.preventDefault(); save(); }
});

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 3,
    state: JSON.parse(JSON.stringify(state)),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `simpleledger-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('importStatus').innerHTML = '<span style="color:var(--paid)">✅ Export downloaded</span>';
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('importStatus');
  statusEl.textContent = 'Reading file...';

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const payload = JSON.parse(e.target.result);
      // Support both wrapped exports (from full app) and raw state
      const data = payload.state || payload;
      if (!data.bills || !Array.isArray(data.bills)) throw new Error('Invalid backup — no bills array found.');
      // Validate bill structure
      const validFreqs = ['monthly','quarterly','yearly','once'];
      data.bills = data.bills.filter(b => {
        if (!b || typeof b.name !== 'string' || typeof b.amount !== 'number') return false;
        if (b.frequency && !validFreqs.includes(b.frequency)) b.frequency = 'monthly';
        if (!b.dueDay || b.dueDay < 1 || b.dueDay > 31) b.dueDay = 1;
        return true;
      });
      if (data.incomes && Array.isArray(data.incomes)) {
        data.incomes = data.incomes.filter(i => i && typeof i.name === 'string' && typeof i.amount === 'number');
      }

      const billCount = (data.bills || []).length;
      const incomeCount = (data.incomes || []).length;
      const savingsCount = (data.savingsAccounts || []).length;
      const dateLabel = payload.exportedAt ? new Date(payload.exportedAt).toLocaleDateString() : 'unknown date';

      if (!confirm(`Import backup from ${dateLabel}?\n\n${billCount} bills, ${incomeCount} income sources, ${savingsCount} savings accounts.\n\nThis will replace ALL current data.`)) {
        event.target.value = '';
        statusEl.textContent = 'Import cancelled.';
        return;
      }

      // Merge imported data, preserve nav state
      const nav = { currentMonth: state.currentMonth, currentYear: state.currentYear };
      Object.assign(state, data, nav);

      // Normalize bills for compatibility
      state.bills = (state.bills || []).map(b => ({
        biller: "", accountId: "", frequency: b.isRecurring === false ? "once" : "monthly", startMonth: 0, ...b
      }));
      if (!state.incomes) state.incomes = [];
      if (!state.payments) state.payments = [];
      if (!state.savingsAccounts) state.savingsAccounts = [];
      if (!state.savingsTransactions) state.savingsTransactions = [];
      if (!state.categories) state.categories = JSON.parse(JSON.stringify(CATEGORIES));
      if (!state.accounts) state.accounts = [];

      saveState();
      render();
      statusEl.innerHTML = `<span style="color:var(--paid)">✅ Imported ${billCount} bills, ${incomeCount} income, ${savingsCount} savings</span>`;
    } catch(err) {
      statusEl.innerHTML = `<span style="color:var(--expense)">❌ ${err.message}</span>`;
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

function openAddModal() { openModal('addModal'); }

function openBillModal(id) {
  editBillId = id || null;
  const bill = id ? state.bills.find(b => b.id === id) : null;

  // Populate category dropdown
  const catSel = document.getElementById('bCat');
  catSel.innerHTML = getCats().map(c => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join('');

  if (bill) {
    document.getElementById('billModalTitle').textContent = 'Edit Bill';
    document.getElementById('bName').value = bill.name;
    document.getElementById('bIcon').value = bill.icon || '';
    document.getElementById('bAmount').value = bill.amount;
    document.getElementById('bDay').value = bill.dueDay;
    catSel.value = bill.category;
    document.getElementById('bFreq').value = bill.frequency || 'monthly';
    document.getElementById('bPay').value = bill.payMethod || 'manual';
    document.getElementById('bUrl').value = bill.payUrl || '';
    document.getElementById('bPlanner').checked = !bill.excludeFromPlanner;
    document.getElementById('billSaveBtn').textContent = 'Save Changes';
    document.getElementById('billDelBtn').classList.remove('hidden');
  } else {
    document.getElementById('billModalTitle').textContent = 'Add Bill';
    document.getElementById('bName').value = '';
    document.getElementById('bIcon').value = '';
    document.getElementById('bAmount').value = '';
    document.getElementById('bDay').value = 1;
    catSel.value = 'housing';
    document.getElementById('bFreq').value = 'monthly';
    document.getElementById('bPay').value = 'manual';
    document.getElementById('bUrl').value = '';
    document.getElementById('bPlanner').checked = true;
    document.getElementById('billSaveBtn').textContent = 'Add Bill';
    document.getElementById('billDelBtn').classList.add('hidden');
    focusField('bName');
  }
  openModal('billModal');
}

function saveBill() {
  const name = document.getElementById('bName').value.trim();
  const amount = parseFloat(document.getElementById('bAmount').value);
  if (!name || isNaN(amount)) return;

  const data = {
    name,
    icon: document.getElementById('bIcon').value.trim(),
    amount,
    dueDay: parseInt(document.getElementById('bDay').value) || 1,
    category: document.getElementById('bCat').value,
    frequency: document.getElementById('bFreq').value,
    payMethod: document.getElementById('bPay').value,
    payUrl: document.getElementById('bUrl').value.trim(),
    isRecurring: document.getElementById('bFreq').value !== 'once',
    excludeFromPlanner: !document.getElementById('bPlanner').checked,
    startMonth: state.currentMonth, // quarter/yearly cycle starts from creation month
    startYear: state.currentYear,   // pins one-time bills to a specific month+year
    biller: '',
    accountId: '',
    updatedAt: Date.now(),          // sync: newest edit wins across devices
  };

  if (editBillId) {
    const bill = state.bills.find(b => b.id === editBillId);
    if (bill) Object.assign(bill, data);
  } else {
    state.bills.push({ id: genId(), ...data });
  }
  saveState();
  closeModal('billModal');
  render();
  haptic(10);
  showToast(editBillId ? `${escHtml(name)} updated` : `✓ ${escHtml(name)} added`);
}

function deleteBill() {
  if (!editBillId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Bill?';
  document.getElementById('confirmText').textContent = 'This will permanently remove this bill.';
  document.getElementById('confirmBtn').onclick = () => {
    const removed = state.bills.find(b => b.id === editBillId);
    const removedPayments = state.payments.filter(p => p.billId === editBillId);
    state.bills = state.bills.filter(b => b.id !== editBillId);
    state.payments = state.payments.filter(p => p.billId !== editBillId);
    if (removed) markDeleted('bill:' + removed.id);
    saveState();
    closeModal('confirmModal');
    closeModal('billModal');
    render();
    if (removed) showToast(`${escHtml(removed.name)} deleted`, { undo: () => {
      unmarkDeleted('bill:' + removed.id);
      removed.updatedAt = Date.now(); // restamp so the restore beats the tombstone on other devices
      state.bills.push(removed);
      state.payments.push(...removedPayments);
      saveState();
      render();
    }});
  };
  openModal('confirmModal');
}

function deleteBillDirect(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  document.getElementById('confirmTitle').textContent = 'Delete Bill?';
  document.getElementById('confirmText').textContent = `Permanently remove "${bill.name}"?`;
  document.getElementById('confirmBtn').onclick = () => {
    const removedPayments = state.payments.filter(p => p.billId === id);
    state.bills = state.bills.filter(b => b.id !== id);
    state.payments = state.payments.filter(p => p.billId !== id);
    markDeleted('bill:' + id);
    saveState();
    closeModal('confirmModal');
    render();
    showToast(`${escHtml(bill.name)} deleted`, { undo: () => {
      unmarkDeleted('bill:' + id);
      bill.updatedAt = Date.now();
      state.bills.push(bill);
      state.payments.push(...removedPayments);
      saveState();
      render();
    }});
  };
  openModal('confirmModal');
}

// Open the bill's stored payment site (Chronicle's "Pay online" pattern)
function openPayUrl(id) {
  const b = state.bills.find(x => x.id === id);
  if (!b?.payUrl) return;
  const url = /^https?:\/\//i.test(b.payUrl) ? b.payUrl : 'https://' + b.payUrl;
  window.open(url, '_blank', 'noopener');
}

function cloneBill(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  const clone = { ...bill, id: genId(), name: bill.name + ' (copy)', updatedAt: Date.now() };
  state.bills.push(clone);
  saveState();
  render();
}

function openIncomeModal(id) {
  editIncomeId = id || null;
  const inc = id ? state.incomes.find(i => i.id === id) : null;

  if (inc) {
    document.getElementById('incomeModalTitle').textContent = 'Edit Income';
    document.getElementById('iName').value = inc.name;
    document.getElementById('iAmount').value = inc.amount;
    document.getElementById('iLastPaid').value = inc.lastPaidDate || '';
    document.getElementById('iFreq').value = inc.frequency || 'monthly';
    document.getElementById('iPlanner').checked = !inc.excludeFromPlanner;
    document.getElementById('incomeSaveBtn').textContent = 'Save Changes';
    document.getElementById('incomeDelBtn').classList.remove('hidden');
  } else {
    document.getElementById('incomeModalTitle').textContent = 'Add Income';
    document.getElementById('iName').value = '';
    document.getElementById('iAmount').value = '';
    document.getElementById('iLastPaid').value = '';
    document.getElementById('iFreq').value = 'monthly';
    document.getElementById('iPlanner').checked = true;
    document.getElementById('incomeSaveBtn').textContent = 'Add Income';
    document.getElementById('incomeDelBtn').classList.add('hidden');
    focusField('iName');
  }
  openModal('incomeModal');
}

function saveIncome() {
  const name = document.getElementById('iName').value.trim();
  const amount = parseFloat(document.getElementById('iAmount').value);
  if (!name || isNaN(amount)) return;

  const data = {
    name,
    amount,
    lastPaidDate: document.getElementById('iLastPaid').value || '',
    frequency: document.getElementById('iFreq').value,
    excludeFromPlanner: !document.getElementById('iPlanner').checked,
    updatedAt: Date.now(),
  };

  if (editIncomeId) {
    const inc = state.incomes.find(i => i.id === editIncomeId);
    if (inc) Object.assign(inc, data);
  } else {
    state.incomes.push({ id: genId(), ...data });
  }
  saveState();
  closeModal('incomeModal');
  render();
  haptic(10);
  showToast(editIncomeId ? `${escHtml(name)} updated` : `✓ ${escHtml(name)} added`);
}

function deleteIncome() {
  if (!editIncomeId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Income?';
  document.getElementById('confirmText').textContent = 'This will remove this income source.';
  document.getElementById('confirmBtn').onclick = () => {
    const removed = state.incomes.find(i => i.id === editIncomeId);
    state.incomes = state.incomes.filter(i => i.id !== editIncomeId);
    if (removed) markDeleted('income:' + removed.id);
    saveState();
    closeModal('confirmModal');
    closeModal('incomeModal');
    render();
    if (removed) showToast(`${escHtml(removed.name)} deleted`, { undo: () => {
      unmarkDeleted('income:' + removed.id);
      removed.updatedAt = Date.now();
      state.incomes.push(removed);
      saveState();
      render();
    }});
  };
  openModal('confirmModal');
}

// ── Savings account CRUD
function openSavingsModal(id) {
  editSavingsId = id || null;
  const acct = id ? (state.savingsAccounts || []).find(a => a.id === id) : null;

  if (acct) {
    document.getElementById('savingsModalTitle').textContent = 'Edit Savings Account';
    document.getElementById('sName').value = acct.name;
    document.getElementById('sType').value = acct.type || 'Savings';
    // Show today's computed balance (deposits + interest) — save only rebases if you change it
    document.getElementById('sBalance').value = computedBalance(acct.id).toFixed(2);
    document.getElementById('sGoal').value = acct.goal || '';
    document.getElementById('sApy').value = acct.apy || '';
    document.getElementById('sContrib').value = acct.contrib || '';
    document.getElementById('sContribDay').value = acct.contribDay || 1;
    document.getElementById('sContribFreq').value = acct.contribFreq || 'monthly';
    document.getElementById('sContribStart').value = acct.contribStart || '';
    document.getElementById('savingsSaveBtn').textContent = 'Save Changes';
    document.getElementById('savingsDelBtn').classList.remove('hidden');
  } else {
    document.getElementById('savingsModalTitle').textContent = 'Add Savings Account';
    document.getElementById('sName').value = '';
    document.getElementById('sType').value = 'Savings';
    document.getElementById('sBalance').value = '';
    document.getElementById('sGoal').value = '';
    document.getElementById('sApy').value = '';
    document.getElementById('sContrib').value = '';
    document.getElementById('sContribDay').value = 1;
    document.getElementById('sContribFreq').value = 'monthly';
    document.getElementById('sContribStart').value = '';
    document.getElementById('savingsSaveBtn').textContent = 'Add Account';
    document.getElementById('savingsDelBtn').classList.add('hidden');
    focusField('sName');
  }
  openModal('savingsModal');
}

function saveSavingsAccount() {
  const name = document.getElementById('sName').value.trim();
  const balance = parseFloat(document.getElementById('sBalance').value) || 0;
  if (!name) return;

  const data = {
    name,
    type: document.getElementById('sType').value,
    goal: parseFloat(document.getElementById('sGoal').value) || 0,
    apy: parseFloat(document.getElementById('sApy').value) || 0,
    contrib: parseFloat(document.getElementById('sContrib').value) || 0,
    contribDay: parseInt(document.getElementById('sContribDay').value) || 1,
    contribFreq: document.getElementById('sContribFreq').value,
    contribStart: document.getElementById('sContribStart').value || '',
    updatedAt: Date.now(),
  };
  // Rebase only when the balance was actually changed — the field shows today's
  // computed value, so an untouched field must not restart the projection
  const currentComputed = editSavingsId ? computedBalance(editSavingsId) : null;
  if (!editSavingsId || currentComputed === null || Math.abs(balance - currentComputed) > 0.005) {
    data.balance = balance;
    data.balanceAsOf = localDateISO(new Date()); // local date — UTC would stamp tomorrow after 5pm PT
  }

  if (!state.savingsAccounts) state.savingsAccounts = [];

  if (editSavingsId) {
    const acct = state.savingsAccounts.find(a => a.id === editSavingsId);
    if (acct) Object.assign(acct, data);
  } else {
    state.savingsAccounts.push({ id: genId(), ...data });
  }
  saveState();
  closeModal('savingsModal');
  render();
  haptic(10);
  showToast(editSavingsId ? `${escHtml(name)} updated` : `✓ ${escHtml(name)} added`);
}

function deleteSavingsAccount() {
  if (!editSavingsId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Savings Account?';
  document.getElementById('confirmText').textContent = 'This will remove this account and all its transaction history.';
  document.getElementById('confirmBtn').onclick = () => {
    const removed = (state.savingsAccounts || []).find(a => a.id === editSavingsId);
    const removedTx = (state.savingsTransactions || []).filter(t => t.accountId === editSavingsId);
    state.savingsAccounts = (state.savingsAccounts || []).filter(a => a.id !== editSavingsId);
    state.savingsTransactions = (state.savingsTransactions || []).filter(t => t.accountId !== editSavingsId);
    if (removed) markDeleted('sav:' + removed.id);
    saveState();
    closeModal('confirmModal');
    closeModal('savingsModal');
    render();
    if (removed) showToast(`${escHtml(removed.name)} deleted`, { undo: () => {
      unmarkDeleted('sav:' + removed.id);
      removed.updatedAt = Date.now();
      state.savingsAccounts.push(removed);
      state.savingsTransactions.push(...removedTx);
      saveState();
      render();
    }});
  };
  openModal('confirmModal');
}

// ═══════════════════════════════════════
//  NOTIFICATIONS
// ═══════════════════════════════════════
const NOTIF_STORAGE_KEY = 'sl_notifications';
const NOTIF_LOG_KEY = 'sl_notif_sent';
const VAPID_PUBLIC_KEY = 'BPBX3p4IUGL2O_lIxncQ18Xo_-twzh9TWaKS1UCslzswPhhmQIOoZN_PvYwMk8US6gsPqcyswUcIECeqn2keyTI';

function getNotifPrefs() {
  try {
    const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return { enabled: false, morningTime: '08:00', dayBefore: true, dayOf: true, deviceId: null };
}

function saveNotifPrefs(prefs) {
  localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(prefs));
}

// Track which notifications we've already sent to avoid duplicates
function getNotifLog() {
  try { return JSON.parse(localStorage.getItem(NOTIF_LOG_KEY) || '{}'); } catch(e) { return {}; }
}
function markNotifSent(key) {
  const log = getNotifLog();
  log[key] = Date.now();
  // Prune entries older than 45 days
  const cutoff = Date.now() - 45 * 86400000;
  Object.keys(log).forEach(k => { if (log[k] < cutoff) delete log[k]; });
  localStorage.setItem(NOTIF_LOG_KEY, JSON.stringify(log));
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  return await Notification.requestPermission();
}

// Gather bills due on a specific date
function billsDueOn(targetDate) {
  const s = loadState();
  const m = targetDate.getMonth(), y = targetDate.getFullYear(), d = targetDate.getDate();
  const allBills = [...s.bills, ...getSavingsContribBills()];
  return allBills.filter(b => {
    if (!isDueThisMonth(b, m, y)) return false;
    if (b.dueDay !== d) return false;
    // Skip already paid
    if (isPaid(b.id, m, y)) return false;
    return true;
  });
}

// Gather incomes due on a specific date
function incomesDueOn(targetDate) {
  const s = loadState();
  const m = targetDate.getMonth(), y = targetDate.getFullYear(), d = targetDate.getDate();
  return s.incomes.filter(inc => {
    const dates = getNextPayDates(inc, 6);
    return dates.some(dt => dt.getMonth() === m && dt.getFullYear() === y && dt.getDate() === d);
  }).filter(inc => {
    // Skip received — match on exact day so a second biweekly check in the same month still notifies
    return !s.incomeReceipts.some(r => r.incomeId === inc.id && r.month === m && r.year === y && r.day === d);
  });
}

function fireNotification(title, body, tag) {
  const log = getNotifLog();
  if (log[tag]) return; // Already sent
  markNotifSent(tag);

  // Prefer service worker notification (works when app is backgrounded on mobile)
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title,
      body,
      tag,
    });
  } else {
    // Fallback to Notification API directly
    try { new Notification(title, { body, tag, icon: 'icon-192.png', badge: 'icon-192.png' }); } catch(e) {}
  }
}

function checkAndNotify() {
  const prefs = getNotifPrefs();
  if (!prefs.enabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const today = new Date();
  today.setHours(0,0,0,0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateStr = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

  // Bills due today
  if (prefs.dayOf) {
    const due = billsDueOn(today);
    if (due.length > 0) {
      const total = due.reduce((s, b) => s + Number(b.amount), 0);
      const names = due.length <= 3 ? due.map(b => b.name).join(', ') : `${due.length} bills`;
      fireNotification(
        `${names} due today`,
        `${fmt(total)} total due`,
        `bills-today-${dateStr(today)}`
      );
    }
    // Income due today
    const inc = incomesDueOn(today);
    if (inc.length > 0) {
      const names = inc.map(i => i.name).join(', ');
      const total = inc.reduce((s, i) => s + Number(i.amount), 0);
      fireNotification(
        `${names} expected today`,
        `${fmt(total)} incoming`,
        `income-today-${dateStr(today)}`
      );
    }
  }

  // Bills due tomorrow (reminder)
  if (prefs.dayBefore) {
    const due = billsDueOn(tomorrow);
    if (due.length > 0) {
      const total = due.reduce((s, b) => s + Number(b.amount), 0);
      const names = due.length <= 3 ? due.map(b => b.name).join(', ') : `${due.length} bills`;
      fireNotification(
        `${names} due tomorrow`,
        `${fmt(total)} total — heads up!`,
        `bills-tmrw-${dateStr(tomorrow)}`
      );
    }
  }
}

// Convert URL-safe base64 to Uint8Array (for VAPID applicationServerKey)
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Subscribe to Web Push via service worker and register with our server
async function subscribeToPush() {
  if (!navigator.serviceWorker) return null;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  return sub;
}

// Sync current bill schedule to the server so the cron job knows what to notify about
async function syncBillScheduleToServer() {
  const prefs = getNotifPrefs();
  if (!prefs.enabled || !prefs.deviceId) return;
  const s = loadState();
  // Build lightweight bill list (regular + savings pseudo-bills)
  const savBills = getSavingsContribBills();
  const allBills = [...s.bills, ...savBills].map(b => ({
    id: b.id, name: b.name, amount: b.amount, dueDay: b.dueDay,
    frequency: b.frequency || 'monthly', startMonth: b.startMonth || 0,
    startYear: b.startYear, payMethod: b.payMethod || 'manual',
  }));
  // Paid markers for current + next month so the cron doesn't notify for bills already paid
  const nowD = new Date();
  const paidKeys = [];
  [[nowD.getMonth(), nowD.getFullYear()],
   [(nowD.getMonth() + 1) % 12, nowD.getMonth() === 11 ? nowD.getFullYear() + 1 : nowD.getFullYear()]].forEach(([mm, yy]) => {
    allBills.forEach(b => { if (isPaid(b.id, mm, yy)) paidKeys.push(`${b.id}:${yy}-${mm}`); });
  });
  const incomes = (s.incomes || []).map(i => ({
    // Server payload keeps the 'source' key for compat, but income objects store the name in .name
    id: i.id, source: i.name || i.source, amount: i.amount, payDay: i.payDay,
    frequency: i.frequency || 'monthly', lastPaidDate: i.lastPaidDate || null,
  }));
  try {
    const sub = await subscribeToPush();
    if (!sub) return;
    await fetch('/.netlify/functions/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: prefs.deviceId, subscription: sub.toJSON(), bills: allBills, incomes, paidKeys }),
    });
  } catch(e) { /* offline — will retry next time */ }
}

// Notification settings toggle (called from UI)
async function toggleNotifications() {
  const prefs = getNotifPrefs();
  const toggle = document.getElementById('notifToggle');
  const statusEl = document.getElementById('notifStatus');

  if (!prefs.enabled) {
    // Turning on
    const result = await requestNotificationPermission();
    if (result === 'granted') {
      try {
        const sub = await subscribeToPush();
        if (!sub) throw new Error('Push subscription failed');
        // Generate a stable device ID
        if (!prefs.deviceId) prefs.deviceId = 'dev_' + genId();
        prefs.enabled = true;
        saveNotifPrefs(prefs);
        toggle.checked = true;
        statusEl.textContent = 'Notifications enabled';
        statusEl.style.color = 'var(--paid)';
        checkAndNotify();
        syncBillScheduleToServer();
      } catch(e) {
        toggle.checked = false;
        statusEl.textContent = 'Push setup failed — try again';
        statusEl.style.color = 'var(--expense)';
      }
    } else if (result === 'denied') {
      toggle.checked = false;
      statusEl.textContent = 'Blocked by browser — check site settings';
      statusEl.style.color = 'var(--expense)';
    } else {
      toggle.checked = false;
      statusEl.textContent = 'Notifications not supported';
      statusEl.style.color = 'var(--text3)';
    }
  } else {
    // Turning off — unsubscribe from server
    try {
      if (prefs.deviceId) {
        await fetch('/.netlify/functions/push-subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: prefs.deviceId }),
        });
      }
    } catch(e) {}
    prefs.enabled = false;
    saveNotifPrefs(prefs);
    toggle.checked = false;
    statusEl.textContent = '';
  }
}

function toggleNotifOption(key) {
  const prefs = getNotifPrefs();
  prefs[key] = !prefs[key];
  saveNotifPrefs(prefs);
}

// Hydrate the notification UI on page load
function initNotifUI() {
  const prefs = getNotifPrefs();
  const toggle = document.getElementById('notifToggle');
  const dayBefore = document.getElementById('notifDayBefore');
  const dayOf = document.getElementById('notifDayOf');
  const statusEl = document.getElementById('notifStatus');
  if (!toggle) return;

  toggle.checked = prefs.enabled;
  if (dayBefore) dayBefore.checked = prefs.dayBefore !== false;
  if (dayOf) dayOf.checked = prefs.dayOf !== false;

  // Show status for denied permission
  if (prefs.enabled && 'Notification' in window && Notification.permission === 'denied') {
    statusEl.textContent = 'Blocked by browser — check site settings';
    statusEl.style.color = 'var(--expense)';
    prefs.enabled = false;
    saveNotifPrefs(prefs);
    toggle.checked = false;
  }

  if (!('Notification' in window)) {
    statusEl.textContent = 'Not supported in this browser';
    statusEl.style.color = 'var(--text3)';
    toggle.disabled = true;
  }
}

// ═══════════════════════════════════════
//  HOUSEHOLD SYNC & BACKUP
//  Full-state blob on Netlify, merged per-record (newest-wins + tombstones)
//  so two active devices can't silently erase each other's changes.
// ═══════════════════════════════════════
const SYNC_KEY = 'sl_sync';

function getSyncCfg() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch(e) { return {}; } }
function saveSyncCfg(c) { localStorage.setItem(SYNC_KEY, JSON.stringify(c)); }

// Passphrase → SHA-256 hex. Server only ever sees the hash.
async function hashHousehold(phrase) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('simpleledger:' + phrase.trim().toLowerCase()));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Merge two full states. Per-record newest-wins; tombstones prevent resurrection.
function mergeStates(a, b) {
  const del = {};
  [...(a.deletions || []), ...(b.deletions || [])].forEach(d => {
    if (!del[d.k] || del[d.k] < d.at) del[d.k] = d.at;
  });
  const ts = o => o.updatedAt || o.at || 0;
  const mergeById = (x = [], y = [], prefix) => {
    const map = {};
    [...x, ...y].forEach(r => { if (r && r.id && (!map[r.id] || ts(r) > ts(map[r.id]))) map[r.id] = r; });
    return Object.values(map).filter(r => !(del[prefix + r.id] > ts(r)));
  };
  const mergeByKey = (x = [], y = [], keyFn, prefix) => {
    const map = {};
    [...x, ...y].forEach(r => { if (!r) return; const k = keyFn(r); if (!map[k] || ts(r) > ts(map[k])) map[k] = r; });
    return Object.values(map).filter(r => !(del[prefix + keyFn(r)] > ts(r)));
  };

  const m = { ...b, ...a }; // scalars/unknown keys: local wins
  m.bills = mergeById(a.bills, b.bills, 'bill:');
  m.incomes = mergeById(a.incomes, b.incomes, 'income:');
  m.savingsAccounts = mergeById(a.savingsAccounts, b.savingsAccounts, 'sav:');
  m.savingsTransactions = mergeById(a.savingsTransactions, b.savingsTransactions, 'stx:');
  m.payments = mergeByKey(a.payments, b.payments, p => `${p.billId}:${p.year}-${p.month}`, 'pay:');
  m.incomeReceipts = mergeByKey(a.incomeReceipts, b.incomeReceipts, r => `${r.incomeId}:${r.year}-${r.month}-${r.day}`, 'rcv:');

  // Planner overrides: newest month-key wins wholesale
  const ovA = a.plannerOverrides || {}, ovB = b.plannerOverrides || {};
  const atA = a.plannerOvAt || {}, atB = b.plannerOvAt || {};
  m.plannerOverrides = {}; m.plannerOvAt = {};
  new Set([...Object.keys(ovA), ...Object.keys(ovB), ...Object.keys(atA), ...Object.keys(atB)]).forEach(k => {
    const useA = (atA[k] || 0) >= (atB[k] || 0);
    const ov = useA ? ovA[k] : ovB[k];
    if (ov && Object.keys(ov).length) m.plannerOverrides[k] = ov;
    m.plannerOvAt[k] = Math.max(atA[k] || 0, atB[k] || 0);
  });

  // Tombstones: union, pruned to 90 days
  const cutoff = Date.now() - 90 * 86400000;
  m.deletions = Object.entries(del).filter(([, at]) => at > cutoff).map(([k, at]) => ({ k, at }));

  // Navigation state never syncs
  m.currentMonth = a.currentMonth;
  m.currentYear = a.currentYear;
  m.schemaVersion = SCHEMA_VERSION;
  return m;
}

let _syncTimer = null, _syncing = false;
function queueSync() {
  if (!getSyncCfg().enabled) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => syncNow(), 3000); // debounce bursts of edits
}

async function syncNow(manual) {
  const cfg = getSyncCfg();
  if (!cfg.enabled || !cfg.key || _syncing || !navigator.onLine) return;
  _syncing = true;
  updateSyncStatus('Syncing…');
  try {
    // Pull → merge → save → push
    const res = await fetch('/.netlify/functions/sync-state?household=' + cfg.key);
    let remote = null;
    if (res.ok) { const j = await res.json(); remote = j.state || null; }
    const local = loadState();
    const merged = remote ? mergeStates(local, remote) : local;
    state = merged;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged)); // direct write — avoid saveState → queueSync loop
    const push = await fetch('/.netlify/functions/sync-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ household: cfg.key, state: merged }),
    });
    if (!push.ok) throw new Error('push failed');
    cfg.lastSync = Date.now();
    saveSyncCfg(cfg);
    updateSyncStatus();
    render();
    if (manual) showToast('✓ Synced');
  } catch (e) {
    updateSyncStatus('Offline — will retry on next change');
    if (manual) showToast('Sync failed — check connection');
  }
  _syncing = false;
}

// ── Sync settings UI (inside the Settings modal)
function initSyncUI() {
  const el = document.getElementById('syncControls');
  if (!el) return;
  const cfg = getSyncCfg();
  if (cfg.enabled) {
    el.innerHTML = `<div style="display:flex;gap:8px">
      <button class="btn-primary" style="flex:1;background:var(--accent)" onclick="syncNow(true)">🔄 Sync Now</button>
      <button class="btn-primary" style="flex:1;background:var(--surface2);color:var(--text);border:1px solid var(--border)" onclick="disableSync()">Turn Off</button>
    </div>
    <p style="font-size:11px;color:var(--text3);margin-top:10px">Use the same passphrase on another phone to share this data.</p>`;
  } else {
    el.innerHTML = `
      <p style="font-size:12px;color:var(--text3);margin-bottom:10px">Automatic cloud backup — and enter the same passphrase on a second phone to share the household data. Data is stored under a hashed key; pick something unguessable.</p>
      <div class="field"><label>Household Passphrase</label><input id="syncPhrase" type="text" placeholder="e.g. two words and a number" autocomplete="off"></div>
      <button class="btn-primary" onclick="enableSync()">Enable Backup & Sync</button>`;
  }
  updateSyncStatus();
}

async function enableSync() {
  const phrase = document.getElementById('syncPhrase')?.value || '';
  if (phrase.trim().length < 8) { showToast('Passphrase needs at least 8 characters'); return; }
  const key = await hashHousehold(phrase);
  saveSyncCfg({ enabled: true, key, lastSync: null });
  initSyncUI();
  haptic(10);
  await syncNow(true); // first sync doubles as restore-on-new-device
}

function disableSync() {
  const cfg = getSyncCfg();
  cfg.enabled = false;
  saveSyncCfg(cfg);
  initSyncUI();
  showToast('Backup off — data stays on this phone only');
}

function updateSyncStatus(msg) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (msg) { el.textContent = msg; return; }
  const cfg = getSyncCfg();
  el.textContent = cfg.enabled
    ? (cfg.lastSync ? 'On · last synced ' + new Date(cfg.lastSync).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'On')
    : 'Off — data lives only on this phone';
}

// ═══════════════════════════════════════
//  INIT
// ═══════════════════════════════════════
state = loadState();
document.body.classList.add('glow-home');
restoreCollapsed();
render();

// Dismiss splash screen — tap anywhere to skip, or auto-dismiss when the animation finishes
(function initSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 700);
  };
  splash.addEventListener('click', dismiss);
  setTimeout(dismiss, 2600); // mark springs in → wordmark rises → rule sweeps → tagline → fade
})();

// Re-render when tab becomes visible; also pull household changes made on the other phone
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { render(); syncNow(); }
});

// Utility class
document.querySelectorAll('.hidden').forEach(el => el.style.display = 'none');
// Fix: use class toggle instead
const style = document.createElement('style');
style.textContent = '.hidden { display: none !important; }';
document.head.appendChild(style);

// Register service worker for PWA install
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});

  // "Mark Paid" tapped on a notification while the app was open
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'MARK_PAID' && Array.isArray(e.data.billIds)) {
      markPaidFromNotification(e.data.billIds, e.data.month, e.data.year);
    }
  });
}

// "Mark Paid" tapped while the app was closed — action arrives via launch URL
(function handleMarkPaidLaunch() {
  const params = new URLSearchParams(location.search);
  if (!params.has('markpaid')) return;
  const ids = params.get('markpaid').split(',').filter(Boolean);
  const m = parseInt(params.get('m')), y = parseInt(params.get('y'));
  history.replaceState(null, '', location.pathname); // clean the URL
  if (ids.length && !isNaN(m) && !isNaN(y)) markPaidFromNotification(ids, m, y);
})();

function markPaidFromNotification(ids, m, y) {
  let n = 0;
  ids.forEach(id => {
    if (!state.bills.some(b => b.id === id)) return;
    if (isPaid(id, m, y)) return;
    unmarkDeleted(`pay:${id}:${y}-${m}`);
    state.payments.push({ billId: id, month: m, year: y, paidDate: new Date().toISOString().slice(0, 10), at: Date.now() });
    n++;
  });
  if (n) {
    saveState();
    render();
    haptic(15);
    showToast(`✓ ${n} bill${n > 1 ? 's' : ''} marked paid`);
  }
}

// PWA app badge: count of unpaid bills due today or overdue (real today, not viewed month)
function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return;
  const now = new Date();
  const m = now.getMonth(), y = now.getFullYear();
  const dim = new Date(y, m + 1, 0).getDate();
  const n = state.bills.concat(getSavingsContribBills())
    .filter(b => isDueThisMonth(b, m, y) && !isPaid(b.id, m, y) && Math.min(b.dueDay, dim) <= now.getDate())
    .length;
  (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge())?.catch?.(() => {});
}

// Init notifications + sync
initNotifUI();
initSyncUI();
setTimeout(() => syncNow(), 1500); // pull the household's latest shortly after load
setTimeout(checkAndNotify, 2000); // Local check shortly after load
setTimeout(syncBillScheduleToServer, 5000); // Sync bill schedule to push server
setInterval(checkAndNotify, 4 * 60 * 60 * 1000); // Re-check every 4h while open

// ═══════════════════════════════════════
//  SWIPE-TO-PAY (Bills tab)
//  Swipe a bill card right past the threshold to toggle paid — one gesture,
//  no detail view. Vertical intent falls through to normal scrolling.
// ═══════════════════════════════════════
(function initSwipeToPay() {
  const list = document.getElementById('billList');
  if (!list) return;
  let card = null, sx = 0, sy = 0, dx = 0, active = false, locked = false;
  const THRESHOLD = 72;

  list.addEventListener('touchstart', e => {
    card = e.target.closest('.bill-card');
    if (!card || card.classList.contains('is-savings')) { card = null; return; }
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    dx = 0; active = false; locked = false;
  }, { passive: true });

  list.addEventListener('touchmove', e => {
    if (!card || locked) return;
    dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (!active) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { locked = true; return; } // scrolling
      if (dx > 14 && dx > Math.abs(dy)) active = true; // right-swipe intent
    }
    if (active) {
      const pull = Math.max(0, Math.min(dx, 110));
      card.style.transform = `translateX(${pull}px)`;
      card.classList.toggle('swipe-ready', pull >= THRESHOLD);
    }
  }, { passive: true });

  list.addEventListener('touchend', () => {
    if (!card) return;
    const fire = active && card.classList.contains('swipe-ready');
    const id = card.id.replace('bc-', '');
    card.style.transform = '';
    card.classList.remove('swipe-ready');
    if (fire) togglePaid(id); // togglePaid handles haptic + undo toast
    card = null;
  });
})();

// ═══════════════════════════════════════
//  PULL-TO-REFRESH
// ═══════════════════════════════════════
(function initPullToRefresh() {
  // Create the pull indicator element
  const indicator = document.createElement('div');
  indicator.id = 'pullRefresh';
  indicator.innerHTML = '<div class="pull-spinner"></div><span class="pull-text">Pull to refresh</span>';
  document.body.insertBefore(indicator, document.body.firstChild);

  let startY = 0, currentY = 0, pulling = false, triggered = false;
  const threshold = 80; // px to pull before triggering

  document.addEventListener('touchstart', e => {
    // Only activate when scrolled to top
    if (window.scrollY > 5) return;
    startY = e.touches[0].clientY;
    pulling = true;
    triggered = false;
    indicator.classList.remove('refreshing');
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    currentY = e.touches[0].clientY;
    const dist = Math.max(0, currentY - startY);
    if (dist === 0) return;

    // Dampen the pull distance
    const pull = Math.min(dist * 0.4, 120);
    indicator.style.transform = `translateY(${pull - 50}px)`;
    indicator.style.opacity = Math.min(pull / threshold, 1);

    if (pull >= threshold * 0.4) {
      indicator.querySelector('.pull-text').textContent = pull >= threshold ? 'Release to refresh' : 'Pull to refresh';
    }
    if (pull >= threshold) triggered = true;
    else triggered = false;
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    pulling = false;

    if (triggered) {
      indicator.style.transform = 'translateY(10px)';
      indicator.style.opacity = '1';
      indicator.classList.add('refreshing');
      indicator.querySelector('.pull-text').textContent = 'Refreshing…';

      // Clear SW cache and reload
      if ('caches' in window) {
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => {
          location.reload();
        });
      } else {
        location.reload();
      }
    } else {
      indicator.style.transform = 'translateY(-50px)';
      indicator.style.opacity = '0';
    }
  }, { passive: true });
})();