// ═══════════════════════════════════════
//  SHARED DATA LAYER — same localStorage
// ═══════════════════════════════════════
const STORAGE_KEY = "billTracker_v3";
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
      return p;
    }
  } catch(e) {}
  const now = new Date();
  return {
    currentMonth: now.getMonth(),
    currentYear: now.getFullYear(),
    bills: [], incomes: [], payments: [], incomeReceipts: [],
    savingsAccounts: [], savingsTransactions: [],
    categories: JSON.parse(JSON.stringify(CATEGORIES)),
    accounts: [],
  };
}

// Debounced push sync — avoids hammering server on rapid saves
let _pushSyncTimer = null;
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // Debounce: sync bill schedule to push server 10s after last save
    clearTimeout(_pushSyncTimer);
    _pushSyncTimer = setTimeout(() => { if (typeof syncBillScheduleToServer === 'function') syncBillScheduleToServer(); }, 10000);
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
function fmt(n) { return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function fmtShort(n) { return "$" + (n >= 1000 ? (n/1000).toFixed(1).replace(/\.0$/,"") + "k" : Number(n).toFixed(0)); }
function escHtml(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

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

  if (isPaid(billId, m, y)) {
    state.payments = state.payments.filter(p => !(p.billId === billId && p.month === m && p.year === y));
  } else {
    state.payments.push({ billId, month: m, year: y, date: new Date().toISOString().slice(0, 10), paidDate: new Date().toISOString().slice(0, 10) });
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
  if (isIncomeReceived(incId, month, year, day)) {
    state.incomeReceipts = state.incomeReceipts.filter(r => !(r.incomeId === incId && r.month === month && r.year === year && r.day === day));
  } else {
    state.incomeReceipts.push({ incomeId: incId, month, year, day, date: new Date().toISOString().slice(0,10) });
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
  document.getElementById('payAmtSaveBtn').onclick = () => {
    const amount = parseFloat(document.getElementById('payAmtInput').value);
    if (isNaN(amount) || amount < 0) return;
    const p = state.payments.find(p => p.billId === billId && p.month === state.currentMonth && p.year === state.currentYear);
    if (p) { p.paidAmount = amount; }
    else { state.payments.push({ billId, month: state.currentMonth, year: state.currentYear, paidDate: new Date().toISOString().slice(0,10), paidAmount: amount }); }
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
      sub = dayPaid ? `<div class="hg-date">Paid ${ordinal(dayPaid)}</div>` : '<div class="hg-date">Paid</div>';
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

// Compute savings balance with transactions + accrued auto-deposits
function computedBalance(acctId) {
  const acct = (state.savingsAccounts || []).find(a => a.id === acctId);
  if (!acct) return 0;
  let bal = acct.balance || 0;

  // Add manual transactions (exclude auto-deposit "paid" markers — those are covered by accrual below)
  (state.savingsTransactions || []).filter(t => t.accountId === acctId && !t._pseudoBillId).forEach(t => {
    if (t.type === 'deposit' || t.type === 'interest') bal += t.amount;
    else if (t.type === 'withdrawal') bal -= t.amount;
  });

  // Accrue auto-deposits from contribStart to today
  if (acct.contrib > 0 && acct.contribStart) {
    const start = new Date(acct.contribStart + 'T00:00:00');
    const today = new Date();
    today.setHours(0,0,0,0);
    if (start <= today) {
      const freq = acct.contribFreq || 'monthly';
      let count = 0;
      if (freq === 'monthly') {
        // Count months from start to today (inclusive of start month)
        count = (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());
        // Include current month if we've passed the deposit day
        if (today.getDate() >= (acct.contribDay || 1)) count++;
      } else if (freq === 'biweekly') {
        const msPerDay = 86400000;
        count = Math.floor((today - start) / (14 * msPerDay)) + 1;
      } else if (freq === 'weekly') {
        const msPerDay = 86400000;
        count = Math.floor((today - start) / (7 * msPerDay)) + 1;
      }
      if (count > 0) bal += acct.contrib * count;
    }
  }

  return bal;
}

// ═══════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════
function switchTab(tab) {
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
function render() {
  state = loadState(); // Re-read in case the full app wrote changes

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
}

function renderHome(monthBills) {
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
    <div class="summary-chip chip-left${_prev.left !== undefined && _prev.left !== _cur.left ? ' pop' : ''}"><div class="chip-label">Left Over</div><div class="chip-value${remaining < 0 ? ' negative' : ''}">${fmtShort(remaining)}</div></div>
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
    document.getElementById('upcomingList').innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div>No upcoming bills or paydays<br><span style="font-size:11px;color:var(--text3)">Add bills and income to get started</span></div>';
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

function changePlannerMonth(delta) {
  plannerMonth += delta;
  if (plannerMonth > 11) { plannerMonth = 0; plannerYear++; }
  if (plannerMonth < 0) { plannerMonth = 11; plannerYear--; }
  render();
}

// Move a bill from one paycheck period to another
function moveBillToPeriod(billId, fromIdx, toIdx) {
  // Store overrides in state so they persist
  if (!state.plannerOverrides) state.plannerOverrides = {};
  const key = `${plannerYear}-${plannerMonth}`;
  if (!state.plannerOverrides[key]) state.plannerOverrides[key] = {};
  state.plannerOverrides[key][billId] = toIdx;
  saveState();
  render();
}

function clearPlannerOverrides() {
  if (!state.plannerOverrides) return;
  const key = `${plannerYear}-${plannerMonth}`;
  delete state.plannerOverrides[key];
  saveState();
  render();
}

function renderPlannerTab() {
  const y = plannerYear, m = plannerMonth;
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const mo = SHORT_MONTHS[m];

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

  // Empty state
  if (!payDates.length) {
    document.getElementById('plannerForecast').innerHTML = '';
    document.getElementById('plannerPeriods').innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-icon">📊</div>${plannerIncomes.length === 0 && state.incomes.length > 0 ? 'All income excluded from planner.<br><span style="font-size:11px;color:var(--text3)">Edit an income source to include it.</span>' : 'Add income sources to plan your paychecks'}</div>`;
    return;
  }

  // Build periods
  const periods = payDates.map((pd, i) => {
    const periodStart = pd.date;
    const periodEnd = i < payDates.length - 1 ? payDates[i+1].date - 1 : daysInMonth;
    return { ...pd, periodStart, periodEnd, bills: [], movedBills: new Set() };
  });

  // Get overrides for this month
  const overrideKey = `${y}-${m}`;
  const overrides = (state.plannerOverrides && state.plannerOverrides[overrideKey]) || {};
  const hasOverrides = Object.keys(overrides).length > 0;

  // Assign bills to periods (respecting overrides)
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

  periods.forEach(p => p.bills.sort((a, b) => a.dueDay - b.dueDay));

  // Auto-rebalance (only bills without overrides)
  if (periods.length > 1) {
    const getRem = p => p.amount - p.bills.reduce((s, b) => s + b.amount, 0);
    for (let pass = 0; pass < 20; pass++) {
      const remainings = periods.map(getRem);
      const pctRemaining = remainings.map((r, i) => r / periods[i].amount);
      let worstIdx = 0, bestIdx = 0;
      for (let i = 1; i < periods.length; i++) {
        if (pctRemaining[i] < pctRemaining[worstIdx]) worstIdx = i;
        if (pctRemaining[i] > pctRemaining[bestIdx]) bestIdx = i;
      }
      if (pctRemaining[bestIdx] - pctRemaining[worstIdx] < 0.10) break;
      const worstP = periods[worstIdx], bestP = periods[bestIdx];
      let bestMove = null, bestDelta = Infinity;
      for (const b of worstP.bills) {
        if (overrides[b.id] !== undefined) continue;
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

  // ── Compute totals
  const startingBalance = state.plannerStartBalance || 0;
  const totalIncome = periods.reduce((s, p) => s + p.amount, 0);
  const totalBills = periods.reduce((s, p) => s + p.bills.reduce((ss, b) => ss + b.amount, 0), 0);
  const available = startingBalance + totalIncome - totalBills;
  const adjustMode = window._plannerAdjustMode || false;

  // ── Top: "Available for Spending" hero + month math
  const availCls = available < 0 ? 'pl-hero-neg' : available < totalIncome * 0.1 ? 'pl-hero-tight' : 'pl-hero-ok';

  document.getElementById('plannerForecast').innerHTML = `
    <div class="pl-hero">
      <div class="pl-hero-label">Available for Spending</div>
      <div class="pl-hero-amount ${availCls}">${fmt(available)}</div>
      <div class="pl-hero-math">
        ${startingBalance ? `<span>${fmt(startingBalance)} carry-over</span><span class="pl-hero-op">+</span>` : ''}
        <span class="pl-hero-inc">${fmt(totalIncome)} income</span>
        <span class="pl-hero-op">−</span>
        <span class="pl-hero-exp">${fmt(totalBills)} bills</span>
      </div>
    </div>
    <div class="pl-controls">
      <div class="pl-bal-row">
        <label class="pl-bal-label">Carry-over balance</label>
        <input type="number" class="pl-bal-input" value="${startingBalance}" step="0.01" placeholder="0.00"
          onchange="state.plannerStartBalance=parseFloat(this.value)||0;saveState();render()">
      </div>
      <div class="pl-adjust-row">
        <button class="pl-adjust-btn ${adjustMode ? 'active' : ''}"
          onclick="window._plannerAdjustMode=!window._plannerAdjustMode;render()">
          ${adjustMode ? '✓ Done' : '⇄ Reassign Bills'}
        </button>
        ${hasOverrides ? '<button class="pl-reset-btn" onclick="clearPlannerOverrides()">↺ Reset</button>' : ''}
      </div>
    </div>`;

  // ── Paycheck cards: ledger-style
  document.getElementById('plannerPeriods').innerHTML = periods.map((p, idx) => {
    const totalBillAmt = p.bills.reduce((s, b) => s + b.amount, 0);
    const remaining = p.amount - totalBillAmt;
    const usedPct = p.amount > 0 ? Math.min((totalBillAmt / p.amount) * 100, 100) : 0;
    const healthCls = remaining < 0 ? 'pc-health-neg' : usedPct > 85 ? 'pc-health-tight' : 'pc-health-ok';
    const payDateLabel = `${mo} ${p.date}`;

    const billRows = p.bills.map(b => {
      const cat = catInfo(b.category);
      const paid = isPaid(b.id);
      const dueDay = Math.min(b.dueDay, daysInMonth);
      const isMoved = p.movedBills.has(b.id);

      // Reassign controls (only visible in adjust mode)
      const moveHtml = (adjustMode && periods.length > 1) ? `<div class="pl-move-row">` + periods.map((tp, ti) => {
        if (ti === idx) return '';
        return `<button class="pl-move-btn" onclick="event.stopPropagation();moveBillToPeriod('${b.id}',${idx},${ti})">→ ${escHtml(tp.income.name).substring(0, 12)} (${mo} ${tp.date})</button>`;
      }).filter(Boolean).join('') + '</div>' : '';

      return `<div class="pl-bill${paid ? ' pl-paid' : ''}${isMoved ? ' pl-moved' : ''}">
        <span class="pl-bill-icon" style="background:${cat.color}22">${b.icon || cat.icon}</span>
        <span class="pl-bill-name">${escHtml(b.name)}${isMoved ? '<span class="pl-tag">moved</span>' : ''}</span>
        <span class="pl-bill-due">${mo} ${dueDay}</span>
        <span class="pl-bill-amt${paid ? ' pl-paid' : ''}">${fmt(b.amount)}</span>
        ${moveHtml}
      </div>`;
    }).join('');

    const warningHtml = remaining < 0
      ? `<div class="pl-card-warning">⚠️ Over by ${fmt(Math.abs(remaining))}</div>` : '';

    return `<div class="pl-card ${healthCls}">
      <div class="pl-card-top">
        <div class="pl-card-source">
          <div class="pl-card-name">💵 ${escHtml(p.income.name)}</div>
          <div class="pl-card-date">${payDateLabel} · covers ${mo} ${p.periodStart}–${p.periodEnd}</div>
        </div>
        <div class="pl-card-pay">+${fmt(p.amount)}</div>
      </div>
      <div class="pl-card-bar">
        <div class="pl-card-bar-fill ${healthCls}" style="width:${usedPct}%"></div>
      </div>
      <div class="pl-card-bar-labels">
        <span>${p.bills.length} bill${p.bills.length !== 1 ? 's' : ''}: ${fmt(totalBillAmt)}</span>
        <span>${usedPct.toFixed(0)}% committed</span>
      </div>
      ${warningHtml}
      ${p.bills.length ? `<div class="pl-bill-list">${billRows}</div>` : '<div class="pl-empty-bills">No bills this period</div>'}
      <div class="pl-card-footer ${healthCls}">
        <span class="pl-footer-label">Remaining</span>
        <span class="pl-footer-amount">${fmt(remaining)}</span>
      </div>
    </div>`;
  }).join('');
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
    document.getElementById('billList').innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>No bills this month<br><span style="font-size:11px;color:var(--text3)">Tap ＋ to add your first bill</span></div>';
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
  if (paid) meta = 'Paid';
  else if (du < 0) meta = `${Math.abs(du)}d overdue`;
  else if (du === 0) meta = 'Due today';
  else if (du === 1) meta = 'Due tomorrow';

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
    document.getElementById('incomeList').innerHTML = '<div class="empty-state"><div class="empty-icon">💵</div>No income sources added<br><span style="font-size:11px;color:var(--text3)">Tap ＋ to add your first income</span></div>';
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
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🏦</div>No savings accounts<br><span style="font-size:11px;color:var(--text3)">Tap ＋ to add one</span></div>';
    return;
  }

  // Compute all balances and total
  const balances = accts.map(a => computedBalance(a.id));
  const total = balances.reduce((s, b) => s + b, 0);

  const freqLabel = f => ({ monthly: '/mo', biweekly: '/2wk', weekly: '/wk' }[f] || '/mo');

  const totalHtml = `<div class="savings-total-bar">
    <span class="savings-total-label">Total Saved</span>
    <span class="savings-total-amount">${fmt(total)}</span>
  </div>`;

  const cardsHtml = accts.map((a, i) => {
    const bal = balances[i];
    const goal = a.goal || 0;
    const pct = goal > 0 ? Math.min(100, (bal / goal) * 100) : 0;
    const contribInfo = a.contrib ? `<div class="sav-autodeposit">💰 Auto-deposit: ${fmt(a.contrib)}${freqLabel(a.contribFreq)} on day ${a.contribDay || 1}${a.contribStart ? ' · since ' + a.contribStart : ''}</div>` : '';

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
    </div>`;
  }).join('');

  container.innerHTML = totalHtml + cardsHtml;
}

// ═══════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

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
    document.getElementById('bPlanner').checked = true;
    document.getElementById('billSaveBtn').textContent = 'Add Bill';
    document.getElementById('billDelBtn').classList.add('hidden');
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
    isRecurring: document.getElementById('bFreq').value !== 'once',
    excludeFromPlanner: !document.getElementById('bPlanner').checked,
    startMonth: state.currentMonth, // quarter/yearly cycle starts from creation month
    startYear: state.currentYear,   // pins one-time bills to a specific month+year
    biller: '',
    accountId: '',
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
}

function deleteBill() {
  if (!editBillId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Bill?';
  document.getElementById('confirmText').textContent = 'This will permanently remove this bill.';
  document.getElementById('confirmBtn').onclick = () => {
    state.bills = state.bills.filter(b => b.id !== editBillId);
    state.payments = state.payments.filter(p => p.billId !== editBillId);
    saveState();
    closeModal('confirmModal');
    closeModal('billModal');
    render();
  };
  openModal('confirmModal');
}

function deleteBillDirect(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  document.getElementById('confirmTitle').textContent = 'Delete Bill?';
  document.getElementById('confirmText').textContent = `Permanently remove "${bill.name}"?`;
  document.getElementById('confirmBtn').onclick = () => {
    state.bills = state.bills.filter(b => b.id !== id);
    state.payments = state.payments.filter(p => p.billId !== id);
    saveState();
    closeModal('confirmModal');
    render();
  };
  openModal('confirmModal');
}

function cloneBill(id) {
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  const clone = { ...bill, id: genId(), name: bill.name + ' (copy)' };
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
}

function deleteIncome() {
  if (!editIncomeId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Income?';
  document.getElementById('confirmText').textContent = 'This will remove this income source.';
  document.getElementById('confirmBtn').onclick = () => {
    state.incomes = state.incomes.filter(i => i.id !== editIncomeId);
    saveState();
    closeModal('confirmModal');
    closeModal('incomeModal');
    render();
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
    document.getElementById('sBalance').value = acct.balance || 0;
    document.getElementById('sGoal').value = acct.goal || '';
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
    document.getElementById('sContrib').value = '';
    document.getElementById('sContribDay').value = 1;
    document.getElementById('sContribFreq').value = 'monthly';
    document.getElementById('sContribStart').value = '';
    document.getElementById('savingsSaveBtn').textContent = 'Add Account';
    document.getElementById('savingsDelBtn').classList.add('hidden');
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
    balance,
    goal: parseFloat(document.getElementById('sGoal').value) || 0,
    contrib: parseFloat(document.getElementById('sContrib').value) || 0,
    contribDay: parseInt(document.getElementById('sContribDay').value) || 1,
    contribFreq: document.getElementById('sContribFreq').value,
    contribStart: document.getElementById('sContribStart').value || '',
  };

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
}

function deleteSavingsAccount() {
  if (!editSavingsId) return;
  document.getElementById('confirmTitle').textContent = 'Delete Savings Account?';
  document.getElementById('confirmText').textContent = 'This will remove this account and all its transaction history.';
  document.getElementById('confirmBtn').onclick = () => {
    state.savingsAccounts = (state.savingsAccounts || []).filter(a => a.id !== editSavingsId);
    state.savingsTransactions = (state.savingsTransactions || []).filter(t => t.accountId !== editSavingsId);
    saveState();
    closeModal('confirmModal');
    closeModal('savingsModal');
    render();
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
  }));
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
      body: JSON.stringify({ deviceId: prefs.deviceId, subscription: sub.toJSON(), bills: allBills, incomes }),
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
  setTimeout(dismiss, 11500); // Cover shows → opens → pages flip → entries write → PAID stamp → tagline → fade out
})();

// Re-render when tab becomes visible (covers switching from full app)
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// Utility class
document.querySelectorAll('.hidden').forEach(el => el.style.display = 'none');
// Fix: use class toggle instead
const style = document.createElement('style');
style.textContent = '.hidden { display: none !important; }';
document.head.appendChild(style);

// Register service worker for PWA install
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Init notifications
initNotifUI();
setTimeout(checkAndNotify, 2000); // Local check shortly after load
setTimeout(syncBillScheduleToServer, 5000); // Sync bill schedule to push server
setInterval(checkAndNotify, 4 * 60 * 60 * 1000); // Re-check every 4h while open

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