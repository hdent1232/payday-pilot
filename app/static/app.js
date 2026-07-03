/* PayDay Pilot dashboard */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let STATE = null; // /api/state payload

// ------------------------------------------------------------- utilities

async function api(path, body) {
  if (window.LOCAL_API) return window.LOCAL_API.call(path, body); // serverless mode (Android/file)
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3200);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ------------------------------------------------------------- tabs

$$("#tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("#tabs button").forEach((b) => b.classList.remove("active"));
    $$(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "debts") loadProjection();
    if (btn.dataset.tab === "spending") loadSpending();
  });
});

$("#quit").addEventListener("click", async () => {
  if (!confirm("Quit PayDay Pilot? Your data is saved automatically.")) return;
  try { await api("/api/quit", {}); } catch (e) { /* server is going down */ }
  document.body.innerHTML = "<main><div class='panel'><h2>PayDay Pilot has stopped.</h2>" +
    "<p class='muted'>You can close this browser tab. Run the app again any time — your data is saved.</p></div></main>";
});

// ------------------------------------------------------------- state load

async function loadState() {
  STATE = await api("/api/state");
  renderDashboard();
  renderDebts();
  renderBills();
  renderGoals();
  renderPaycheckHistory();
  renderSettings();
}

// ------------------------------------------------------------- dashboard

// Bills (minus what's already set aside) and debt minimums whose monthly due
// day lands within the next `days` days.
function dueWithinDays(days) {
  const today = new Date((STATE.today || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const inWindow = (dueDay) => {
    const day = Math.max(1, Math.min(28, dueDay));
    const due = new Date(today);
    due.setDate(day);
    if (due < today) due.setMonth(due.getMonth() + 1);
    return (due - today) / 86400000 <= days;
  };
  let total = 0;
  for (const b of STATE.bills) {
    if (inWindow(b.due_day)) total += Math.max(0, b.amount - (b.reserved || 0));
  }
  for (const d of STATE.debts) {
    if (d.balance > 0 && d.min_payment > 0 && inWindow(d.due_day)) {
      total += Math.min(d.min_payment, d.balance);
    }
  }
  return { total: Math.round(total * 100) / 100 };
}

function renderDashboard() {
  const { debts, bills, settings, budget, paychecks } = STATE;
  const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
  const totalBills = bills.reduce((s, b) => s + b.amount, 0);
  const mins = debts.reduce((s, d) => s + (d.balance > 0 ? Math.min(d.min_payment, d.balance) : 0), 0);
  const ef = Number(settings.emergency_balance);
  const efT = Number(settings.emergency_target);

  // live bank balance vs what's due in the next 14 days
  const balance = settings.bank_balance === "" ? null : Number(settings.bank_balance);
  const dueSoon = dueWithinDays(14);
  let balSub = "tap to set your checking balance";
  let balClass = "";
  if (balance !== null) {
    balSub = balance >= dueSoon.total
      ? `covers the ${money(dueSoon.total)} due in the next 14 days ✓`
      : `short ${money(dueSoon.total - balance)} of the ${money(dueSoon.total)} due in the next 14 days`;
    balClass = balance >= dueSoon.total ? "good" : "bad";
    if (settings.bank_balance_updated) balSub += ` · updated ${fmtDate(settings.bank_balance_updated)}`;
  }

  $("#dash-cards").innerHTML = `
    <div class="card ${balClass}">
      <div class="label">Bank balance (live)</div>
      <div class="value">${balance === null ? "—" : money(balance)}</div>
      <div class="sub">${balSub}</div>
      <div class="row-form" style="margin-top:6px">
        <input type="number" step="0.01" id="dash-balance" placeholder="current balance" style="width:130px">
        <button class="mini" id="dash-balance-save">update</button>
      </div>
    </div>
    <div class="card ${totalDebt > 0 ? "bad" : "good"}">
      <div class="label">Total debt</div><div class="value">${money(totalDebt)}</div>
      <div class="sub">${debts.filter((d) => d.balance > 0).length} active account(s)</div>
    </div>
    <div class="card">
      <div class="label">Monthly bills</div><div class="value">${money(totalBills)}</div>
      <div class="sub">+ ${money(mins)} debt minimums</div>
    </div>
    <div class="card">
      <div class="label">Est. monthly income</div><div class="value">${money(budget.monthly_income)}</div>
      <div class="sub">${budget.pattern
        ? `paid ${budget.pattern.frequency} (~${money(budget.pattern.typical_amount)}) · next payday ~${fmtDate(budget.pattern.next_payday)}`
        : budget.monthly_income ? "" : "upload pay stubs or import statements"}</div>
    </div>
    <div class="card ${budget.monthly_extra > 0 ? "good" : "warn"}">
      <div class="label">Free for extra debt payoff</div><div class="value">${money(budget.monthly_extra)}</div>
      <div class="sub">per month after bills &amp; essentials</div>
    </div>
    <div class="card ${ef >= efT ? "good" : ""}">
      <div class="label">Emergency fund</div><div class="value">${money(ef)}</div>
      <div class="sub">target ${money(efT)}</div>
    </div>`;
  $("#dash-balance-save").addEventListener("click", async () => {
    const v = $("#dash-balance").value;
    if (v === "") { toast("Enter your current balance first."); return; }
    await api("/api/settings", {
      bank_balance: String(Number(v)),
      bank_balance_updated: STATE.today || new Date().toISOString().slice(0, 10),
    });
    toast("Balance updated.");
    await loadState();
  });

  const latest = paychecks[0];
  if (latest && latest.plan) {
    $("#dash-plan").innerHTML =
      `<p class="muted small">${esc(latest.source)} of <b>${money(latest.amount)}</b> on ${fmtDate(latest.date)}</p>` +
      renderPlanItems(latest.plan, true);
  }
  loadDashOutlook();
}

// The whole point of the app in one panel: a dated, ordered to-do list.
// Pay these bills/minimums on these days, send the leftover to this debt,
// and stop this specific spending to make it bigger.
function renderActionPlan(p) {
  const el = $("#dash-actions");
  const today = new Date((STATE.today || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const nextDue = (dueDay) => {
    const due = new Date(today);
    due.setDate(Math.max(1, Math.min(28, dueDay)));
    if (due < today) due.setMonth(due.getMonth() + 1);
    return due;
  };
  const iso = (d) => d.toISOString().slice(0, 10);
  const f = p && p.forecast;
  // cash-flow verification: every payment below was simulated day by day
  // against predicted paychecks, the bank balance and daily essentials
  const cov = {};
  if (f) for (const it of f.items) cov[it.label + "|" + it.date] = it.covered;

  const steps = [];
  // past-due catch-ups come before everything — today, not on a due day
  for (const d of STATE.debts) {
    if (d.past_due > 0.01 && d.balance > 0.01) {
      steps.push({ date: today, badge: "debt_min", label: `CATCH UP ${d.name}`,
        amount: Math.min(d.past_due, d.balance),
        note: "past due — pay this before anything else" });
    }
  }
  for (const b of STATE.bills) {
    const owed = Math.max(0, b.amount - (b.reserved || 0));
    if (owed > 0.01) {
      const due = nextDue(b.due_day);
      steps.push({ date: due, badge: "bill", label: `Pay ${b.name}`, fkey: `${b.name}|${iso(due)}`,
        amount: owed, note: b.reserved > 0.01 ? `${money(b.reserved)} already set aside` : b.category });
    }
  }
  for (const d of STATE.debts) {
    if (d.balance > 0.01 && d.min_payment > 0.01) {
      const due = nextDue(d.due_day);
      steps.push({ date: due, badge: "debt_min",
        label: `Pay ${d.name} minimum`, fkey: `${d.name} minimum|${iso(due)}`,
        amount: Math.min(d.min_payment, d.balance),
        note: `${d.apr_estimated ? "~" : ""}${d.apr.toFixed(2)}% APR, ${money(d.balance)} left` });
    }
  }
  // planned purchases: keep setting aside so the money is ready on the date
  for (const g of STATE.goals || []) {
    const needed = Math.max(0, g.amount - g.saved);
    if (needed > 0.01) {
      const due = new Date(g.due_date + "T00:00:00");
      steps.push({ date: due, badge: "reserve",
        label: `Have "${g.name}" money ready`, fkey: `${g.name}|${iso(due)}`, amount: g.amount,
        note: `${money(g.saved)} of ${money(g.amount)} set aside — ${money(goalPerCheck(g))}/paycheck` });
    }
  }
  if (!steps.length && !STATE.debts.length) {
    el.textContent = "Add your bills and debts, then import a bank statement — the app turns them " +
      "into a dated to-do list: pay this there on that day, stop spending here.";
    return;
  }
  steps.sort((a, b) => a.date - b.date);
  const within30 = steps.filter((s) => s.badge === "reserve" || (s.date - today) / 86400000 <= 30);

  // header: the mathematical verdict from the day-by-day simulation
  let html = "";
  if (f) {
    if (!f.income_per_check) {
      html += `<p class="muted small">Upload your pay stubs (Paycheck tab) so every payment below can be
        verified against your actual paychecks, day by day.</p>`;
    } else if (!f.balance_known) {
      html += `<div class="warnbox">Set your <b>live bank balance</b> (first card above) — then every payment
        below is verified day-by-day against your ~${money(f.income_per_check)} paychecks, and you'll see
        exactly where money runs short.</div>`;
    } else if (f.feasible) {
      html += `<div class="okbox">✓ <b>Verified by cash-flow simulation:</b> starting from your
        ${money(f.start_balance)} balance, with ~${money(f.income_per_check)} paychecks
        (${f.checks_in_horizon} expected), every payment below is covered on time through
        ${fmtDate(f.horizon_end)}. Projected balance then: ${money(f.end_balance)}.</div>`;
    } else {
      html += `<div class="warnbox">⚠ <b>Cash-flow check failed:</b> on <b>${fmtDate(f.first_shortfall.date)}</b>,
        <b>${esc(f.first_shortfall.label)}</b> comes up <b>${money(f.first_shortfall.short)}</b> short.
        Free up at least that much before then — the cuts below are sized for exactly this.</div>`;
    }
    if (f.past_due_total > 0 && f.income_per_check && f.balance_known) {
      html += f.caught_up_by
        ? `<div class="okbox">Following this plan you are <b>fully caught up</b> on the
            ${money(f.past_due_total)} past due by <b>${fmtDate(f.caught_up_by)}</b> —
            after that every dollar goes to payoff, not arrears.</div>`
        : `<div class="warnbox">Even putting every spare dollar toward arrears, ${money(f.arrears_left)}
            of the ${money(f.past_due_total)} past due is still unpaid ${fmtDate(f.horizon_end)} —
            the cuts below shorten that.</div>`;
    }
  }

  html += within30.map((s) => {
    const covered = s.fkey ? cov[s.fkey] : undefined;
    return `<div class="plan-item">
      <span class="badge ${s.badge}">${fmtDate(s.date.toISOString().slice(0, 10))}</span>
      <span><span class="what">${esc(s.label)}</span>${covered === false ? " <span class='badge debt_min'>⚠ short</span>" : covered === true ? " <span class='badge savings'>✓ covered</span>" : ""}<br><span class="why">${esc(s.note)}</span></span>
      <span class="amt">${money(s.amount)}</span></div>`;
  }).join("");
  // then: everything left goes to the strategy target
  const target = p && p.advice && p.advice.target_debt;
  const extra = p ? p.extra_used : STATE.budget.monthly_extra;
  if (target && extra > 0) {
    html += `<div class="plan-item"><span class="badge debt_extra">every payday</span>
      <span><span class="what">Send everything left to ${esc(target)}</span><br>
      <span class="why">~${money(extra)}/mo extra — ${STATE.settings.strategy} target</span></span>
      <span class="amt">${money(extra)}/mo</span></div>`;
  }
  // and: the specific spending to stop, feeding that payment
  if (p && p.advice && p.advice.suggestions.length) {
    for (const s of p.advice.suggestions.filter((x) => x.suggested_cut > 0).slice(0, 3)) {
      html += `<div class="plan-item"><span class="badge fun">${esc(s.action)}</span>
        <span><span class="what">${{ cancel: "Cancel", eliminate: "Stop", squeeze: "Squeeze" }[s.action] || "Halve"} ${esc(s.label)}</span><br>
        <span class="why">${esc(s.message)}</span></span>
        <span class="amt">+${money(s.suggested_cut)}/mo${target ? " → " + esc(target) : ""}</span></div>`;
    }
  }
  el.innerHTML = html || "Nothing due in the next 30 days.";
}

async function loadDashOutlook() {
  const el = $("#dash-outlook");
  const debts = STATE.debts.filter((d) => d.balance > 0);
  if (!debts.length) {
    renderActionPlan(null);
    el.innerHTML = STATE.debts.length
      ? "<div class='okbox'>🎉 All debts are paid off!</div>"
      : "Add your debts to see a payoff projection.";
    return;
  }
  try {
    const p = await api("/api/projection");
    renderActionPlan(p);
    const s = p.comparison[STATE.settings.strategy];
    const minOnly = p.comparison.minimum_only;
    if (s.stuck) {
      el.innerHTML = "<div class='warnbox'>⚠️ At the current payments your debts never get paid down. " +
        "Open the <b>Debts</b> tab — the payoff plan there shows which debts are stuck and " +
        "which spending to cut to fix it.</div>";
      return;
    }
    let html = `<div class="cards">
      <div class="card good"><div class="label">Debt-free date</div><div class="value">${fmtDate(s.debt_free_date)}</div>
        <div class="sub">${s.months} months, ${STATE.settings.strategy} + ${money(p.extra_used)}/mo extra</div></div>
      <div class="card"><div class="label">Interest you'll pay</div><div class="value">${money(s.total_interest)}</div>
        <div class="sub">${minOnly.months && !minOnly.stuck ? "vs " + money(minOnly.total_interest) + " with minimums only" : ""}</div></div>
    </div>`;
    if (s.payoff_order.length) {
      html += "<p class='muted small'>Payoff order: " +
        s.payoff_order.map((o) => `<b>${esc(o.name)}</b> (${fmtDate(o.date)})`).join(" → ") + "</p>";
    }
    el.innerHTML = html;
  } catch (e) {
    renderActionPlan(null);
    el.textContent = "Couldn't compute projection: " + e.message;
  }
}

// ------------------------------------------------------------- paycheck

// Upload a pay stub: text is extracted on-device (pdf.js) and the parsed net
// pay/date/employer fill the form for review — nothing is saved until
// "Create plan".
$("#pc-file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const readStub = async (f) => {
    const text = /\.pdf$/i.test(f.name) || f.type === "application/pdf"
      ? await extractPdfText(f) : await f.text();
    return (await api("/api/paycheck/parse", { text })).stub;
  };
  // one file: prefill the form for review
  if (files.length === 1) {
    const f = files[0];
    try {
      toast(`Reading ${f.name}…`);
      const stub = await readStub(f);
      if (!stub) { toast(`${f.name}: couldn't find a pay amount — enter it manually.`); return; }
      $("#pc-amount").value = stub.amount;
      if (stub.date) $("#pc-date").value = stub.date;
      if (stub.source) $("#pc-source").value = stub.source;
      toast(stub.net
        ? `Read ${money(stub.amount)} net pay${stub.date ? " on " + fmtDate(stub.date) : ""} — review, then Create plan.`
        : `Only found GROSS pay ${money(stub.amount)} — enter your net (take-home) amount before creating the plan.`);
    } catch (err) {
      toast(`${f.name}: ${err.message}`);
    }
    return;
  }
  // many files: import into history so the app learns the pay pattern —
  // no plans are run, no balances change
  toast(`Reading ${files.length} pay stubs…`);
  const items = [];
  const failed = [];
  for (const f of files) {
    try {
      const stub = await readStub(f);
      if (stub && stub.date) items.push(stub);
      else failed.push(f.name);
    } catch (err) {
      failed.push(f.name);
    }
  }
  if (!items.length) { toast("Couldn't read a pay amount + date from any of those files."); return; }
  const r = await api("/api/paycheck/history", { items });
  let msg = `Imported ${r.added} paycheck(s) into history` +
    (r.duplicates ? `, skipped ${r.duplicates} duplicate(s)` : "") + ".";
  if (r.pattern) {
    msg += ` Pay pattern: ${r.pattern.frequency}, ~${money(r.pattern.typical_amount)} — ` +
      `next payday ~${fmtDate(r.pattern.next_payday)}.`;
  }
  if (failed.length) msg += ` Couldn't read: ${failed.join(", ")}.`;
  toast(msg);
  await loadState();
});

$("#pc-date").value = new Date().toISOString().slice(0, 10);

$("#paycheck-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submitPaycheck(false);
});
$("#pc-preview").addEventListener("click", () => submitPaycheck(true));

async function submitPaycheck(preview) {
  const amount = parseFloat($("#pc-amount").value);
  if (!amount || amount <= 0) { toast("Enter the paycheck amount."); return; }
  try {
    const { plan } = await api("/api/paycheck", {
      amount, date: $("#pc-date").value, source: $("#pc-source").value || "Paycheck", preview,
    });
    renderPlan(plan, preview);
    if (!preview) {
      toast("Plan saved. Balances and bill set-asides updated.");
      await loadState();
    }
  } catch (err) {
    toast("Error: " + err.message);
  }
}

function renderPlanItems(plan, compact) {
  let html = "";
  if (!compact) {
    const t = plan.totals;
    html += `<div class="summary-chips">
      ${t.catch_up ? `<span class="chip">Catch-up: <b>${money(t.catch_up)}</b></span>` : ""}
      <span class="chip">Bills: <b>${money(t.bills)}</b></span>
      <span class="chip">Debt minimums: <b>${money(t.debt_min)}</b></span>
      ${t.goals ? `<span class="chip">Purchases: <b>${money(t.goals)}</b></span>` : ""}
      <span class="chip">Extra to debt: <b>${money(t.debt_extra)}</b></span>
      <span class="chip">Essentials: <b>${money(t.essentials)}</b></span>
      <span class="chip">Emergency: <b>${money(t.emergency)}</b></span>
      <span class="chip">Fun: <b>${money(t.fun)}</b></span>
      ${t.savings ? `<span class="chip">Savings: <b>${money(t.savings)}</b></span>` : ""}
    </div>`;
  }
  html += plan.items.map((i) => `
    <div class="plan-item">
      <span class="badge ${i.kind}">${{
        bill: "pay bill", reserve: "set aside", debt_min: "debt min", debt_extra: "extra debt",
        catchup: "catch up", goal: "purchase",
        essentials: "essentials", emergency: "emergency", fun: "fun", savings: "savings",
      }[i.kind] || i.kind}</span>
      <span><span class="what">${esc(i.action)}</span><br><span class="why">${esc(i.note)}</span></span>
      <span class="amt">${money(i.amount)}</span>
    </div>`).join("");
  return html;
}

function renderPlan(plan, preview) {
  const out = $("#plan-output");
  out.style.display = "block";
  let html = `<h2>${preview ? "Preview — " : ""}Your plan for the ${money(plan.amount)} paycheck (${fmtDate(plan.pay_date)})</h2>`;
  html += `<p class="muted small">This plan covers you until your next expected paycheck around <b>${fmtDate(plan.next_paycheck_expected)}</b>.</p>`;
  plan.warnings.forEach((w) => { html += `<div class="warnbox">⚠️ ${esc(w)}</div>`; });
  html += renderPlanItems(plan, false);
  if (plan.impact && plan.impact.months_saved > 0) {
    html += `<div class="okbox">🚀 Keeping this up, the extra payments make you debt-free
      <b>${plan.impact.months_saved} month(s) sooner</b> (by ${fmtDate(plan.impact.debt_free_date)})
      and save <b>${money(plan.impact.interest_saved)}</b> in interest.</div>`;
  }
  if (preview) {
    html += `<p class="muted small">This is a preview — nothing was saved. Click <b>Create plan</b> to commit it.</p>`;
  }
  out.innerHTML = html;
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderPaycheckHistory() {
  const el = $("#paycheck-history");
  if (!STATE.paychecks.length) { el.textContent = "Nothing yet."; return; }
  el.innerHTML = `<table class="table"><thead><tr>
      <th>Date</th><th>Source</th><th class="num">Amount</th><th class="num">To bills</th>
      <th class="num">To debt</th><th></th></tr></thead><tbody>` +
    STATE.paychecks.map((p) => {
      const t = p.plan ? p.plan.totals : null;
      return `<tr>
        <td>${fmtDate(p.date)}</td><td>${esc(p.source)}</td>
        <td class="num">${money(p.amount)}</td>
        <td class="num">${t ? money(t.bills) : "—"}</td>
        <td class="num">${t ? money(t.debt_min + t.debt_extra) : "—"}</td>
        <td><button class="mini ghost" data-show="${p.id}">view</button>
            <button class="mini danger ghost" data-del="${p.id}">✕</button></td></tr>`;
    }).join("") + "</tbody></table>";
  el.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => {
    const p = STATE.paychecks.find((x) => x.id == b.dataset.show);
    if (p && p.plan) renderPlan(p.plan, false);
  }));
  el.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this paycheck record? (Debt balances and set-asides are not reverted.)")) return;
    await api("/api/paycheck/delete", { id: Number(b.dataset.del) });
    await loadState();
  }));
}

// ------------------------------------------------------------- debts

const KIND_LABELS = {
  credit_card: "Credit card", auto_loan: "Auto loan", student_loan: "Student loan",
  personal: "Personal loan", medical: "Medical", mortgage: "Mortgage", other: "Other",
};

function renderDebts() {
  const tbody = $("#debt-table tbody");
  if (!STATE.debts.length) {
    tbody.innerHTML = "<tr><td colspan='8' class='muted'>No debts yet — add them below or import from your credit report.</td></tr>";
    return;
  }
  tbody.innerHTML = STATE.debts.map((d) => `<tr>
      <td>${esc(d.name)}${d.past_due > 0 ? `<br><span class="why" style="color:var(--red)">⚠ ${money(d.past_due)} past due</span>` : ""}</td><td>${KIND_LABELS[d.kind] || esc(d.kind)}</td>
      <td class="num">${money(d.balance)}</td><td class="num" ${d.apr_estimated ? 'title="estimated — edit to your real rate"' : ""}>${d.apr_estimated ? "~" : ""}${d.apr.toFixed(2)}%</td>
      <td class="num">${money(d.min_payment)}</td><td class="num">${d.term_months ?? "—"}</td>
      <td class="num">${d.due_day}</td>
      <td><button class="mini ghost" data-edit="${d.id}">edit</button>
          <button class="mini danger ghost" data-del="${d.id}">✕</button></td></tr>`).join("");
  tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
    const d = STATE.debts.find((x) => x.id == b.dataset.edit);
    $("#d-id").value = d.id; $("#d-name").value = d.name; $("#d-kind").value = d.kind;
    $("#d-balance").value = d.balance; $("#d-apr").value = d.apr; $("#d-min").value = d.min_payment;
    $("#d-pastdue").value = d.past_due || 0;
    $("#d-term").value = d.term_months ?? ""; $("#d-due").value = d.due_day;
    $("#d-submit").textContent = "Save debt"; $("#d-cancel").style.display = "";
  }));
  tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this debt?")) return;
    await api("/api/debts/delete", { id: Number(b.dataset.del) });
    await loadState(); loadProjection();
  }));
}

$("#debt-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/debts", {
    id: $("#d-id").value ? Number($("#d-id").value) : null,
    name: $("#d-name").value, kind: $("#d-kind").value,
    balance: $("#d-balance").value, apr: $("#d-apr").value,
    min_payment: $("#d-min").value, term_months: $("#d-term").value || null,
    past_due: $("#d-pastdue").value || 0,
    due_day: $("#d-due").value,
  });
  resetDebtForm();
  toast("Debt saved.");
  await loadState(); loadProjection();
});
$("#d-cancel").addEventListener("click", resetDebtForm);

function resetDebtForm() {
  $("#debt-form").reset();
  $("#d-id").value = "";
  $("#d-submit").textContent = "Add debt";
  $("#d-cancel").style.display = "none";
}

// ---- credit report import

$("#debt-import-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
    toast(`Reading ${f.name}…`);
    try {
      $("#debt-import-text").value = await extractPdfText(f);
    } catch (err) {
      toast(`${f.name}: ${err.message}`);
      return;
    }
    $("#debt-import-parse").click();
  } else {
    $("#debt-import-text").value = await f.text();
  }
});

$("#debt-csv-template").addEventListener("click", (e) => {
  e.preventDefault();
  const csv = "name,balance,apr,min payment,term,due day\nCapital One Visa,2450.00,26.99,75,,15\nToyota auto loan,14800,6.4,385,48,5\n";
  download("debts-template.csv", csv, "text/csv");
});

$("#debt-import-parse").addEventListener("click", async () => {
  const text = $("#debt-import-text").value.trim();
  if (!text) { toast("Paste your credit report text or CSV first."); return; }
  const { debts, source } = await api("/api/debts/import", { text });
  const el = $("#debt-import-review");
  if (!debts.length) {
    el.innerHTML = "<div class='warnbox'>Couldn't find any accounts in that text. Try the CSV template instead — " +
      "columns: name, balance, apr, min payment, term, due day.</div>";
    return;
  }
  const sourceLabel = { csv: "CSV", report: "credit report" }[source] || "text scan";
  const updates = debts.filter((d) => d.match_id).length;
  el.innerHTML = `<p class="muted small">Found ${debts.length} account(s) (${sourceLabel})${
      updates ? ` — <b>${updates}</b> match debts you already track and will be updated, not duplicated` : ""}.
      Review, fix anything that's off, then confirm.
      APRs marked <i>calc.</i> are calculated from the loan's own amount, payment and term in the document;
      <i>est.</i> are typical rates for the debt type (credit reports don't list rates). Edit either to your real rate:</p>
    <table class="table"><thead><tr><th></th><th>Name</th><th class="num">Balance</th>
      <th class="num">APR %</th><th class="num">Min payment</th><th>Action</th></tr></thead><tbody>` +
    debts.map((d, i) => `<tr>
      <td><input type="checkbox" checked data-i="${i}"></td>
      <td><input value="${esc(d.name)}" data-f="name" data-i="${i}"></td>
      <td class="num"><input type="number" step="0.01" value="${d.balance}" data-f="balance" data-i="${i}" style="width:110px"></td>
      <td class="num"><input type="number" step="0.01" value="${d.apr}" data-f="apr" data-i="${i}" style="width:80px">${
        d.apr_derived ? "<span class='muted small'> calc.</span>" : d.apr_estimated ? "<span class='muted small'> est.</span>" : ""}</td>
      <td class="num"><input type="number" step="0.01" value="${d.min_payment}" data-f="min_payment" data-i="${i}" style="width:100px"></td>
      <td class="small">${d.match_id ? `updates <b>${esc(d.match_name)}</b>` : "new"}</td>
    </tr>`).join("") +
    `</tbody></table><button class="primary" id="debt-import-confirm">${
      updates ? "Add & update selected debts" : "Add selected debts"}</button>`;
  el._debts = debts;
  $("#debt-import-confirm").addEventListener("click", async () => {
    const rows = el._debts.map((d) => ({ ...d }));
    el.querySelectorAll("input[data-f]").forEach((inp) => {
      rows[Number(inp.dataset.i)][inp.dataset.f] = inp.type === "number" ? Number(inp.value) : inp.value;
    });
    // an APR the user typed over in the review is real, not an estimate
    rows.forEach((row, i) => {
      if (Number(row.apr) !== Number(el._debts[i].apr)) {
        row.apr_estimated = false;
        row.apr_derived = false;
      }
    });
    const selected = [];
    el.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      if (cb.checked) selected.push(rows[Number(cb.dataset.i)]);
    });
    if (!selected.length) { toast("Nothing selected."); return; }
    let added = 0, updated = 0;
    const payload = selected.map((row) => {
      const ex = row.match_id && STATE.debts.find((d) => d.id === row.match_id);
      if (!ex) { added++; return row; }
      updated++;
      // reconcile: new document wins for balance/payment/term, but a rate the
      // user set themselves is never overwritten by a guess or a calculation
      const userSetApr = ex.apr > 0 && !ex.apr_estimated;
      return {
        ...row,
        id: ex.id,
        name: ex.name,
        apr: userSetApr ? ex.apr : (row.apr || ex.apr),
        apr_estimated: userSetApr ? false : (row.apr ? !!row.apr_estimated : !!ex.apr_estimated),
        past_due: row.past_due != null ? row.past_due : ex.past_due,
        min_payment: row.min_payment || ex.min_payment,
        kind: row.kind !== "other" ? row.kind : ex.kind,
        term_months: row.term_months || ex.term_months,
        due_day: ex.due_day,
        account_last4: row.account_last4 || ex.account_last4,
        notes: ex.notes,
      };
    });
    await api("/api/debts", payload);
    el.innerHTML = ""; $("#debt-import-text").value = "";
    toast(`${added ? `Added ${added} debt(s). ` : ""}${updated ? `Updated ${updated} existing debt(s).` : ""}`.trim());
    await loadState(); loadProjection();
  });
});

// ---- payoff projection

$("#proj-refresh").addEventListener("click", loadProjection);

async function loadProjection() {
  const el = $("#projection");
  if (!STATE || !STATE.debts.some((d) => d.balance > 0)) {
    el.innerHTML = "<p class='muted'>Add debts with balances to compare payoff strategies.</p>";
    return;
  }
  const extraInput = $("#proj-extra").value;
  const q = extraInput !== "" ? `?extra=${encodeURIComponent(extraInput)}` : "";
  const p = await api("/api/projection" + q);
  $("#proj-extra").placeholder = `auto: ${p.budget.monthly_extra}`;
  const c = p.comparison;
  const fmt = (r, label) => {
    if (r.stuck || !r.months) {
      return `<div class="card bad"><div class="label">${label}</div>
        <div class="value">never</div><div class="sub">balance never reaches zero</div></div>`;
    }
    return `<div class="card ${label.toLowerCase().includes(STATE.settings.strategy) ? "winner" : ""}">
      <div class="label">${label}</div>
      <div class="value">${r.months} mo</div>
      <div class="sub">debt-free ${fmtDate(r.debt_free_date)}<br>${money(r.total_interest)} total interest</div></div>`;
  };
  let html = `<div class="compare">
    ${fmt(c.minimum_only, "Minimums only")}
    ${fmt(c.snowball, "Snowball")}
    ${fmt(c.avalanche, "Avalanche")}
  </div>
  <p class="muted small">Using ${money(p.extra_used)}/month extra toward debt. Your selected strategy:
    <b>${STATE.settings.strategy}</b> (change in Settings).</p>`;
  const active = c[STATE.settings.strategy];
  if (active.stuck && active.stuck_debts) {
    const nopay = active.stuck_debts.filter((d) => d.reason === "no_payment").map((d) => esc(d.name));
    const interest = active.stuck_debts.filter((d) => d.reason === "interest").map((d) => esc(d.name));
    const why = [];
    if (nopay.length) {
      why.push(`nothing is being paid toward <b>${nopay.join(", ")}</b> — ` +
        (nopay.length > 1 ? "they have" : "it has") +
        " no minimum payment and there's no extra money to send");
    }
    if (interest.length) {
      why.push(`interest on <b>${interest.join(", ")}</b> grows faster than the payments going in`);
    }
    html += `<div class="warnbox">This plan never gets you debt-free: ${why.join("; ")}.</div>`;
  }
  if (p.budget.monthly_income <= 0) {
    html += `<p class="muted small">The extra-$ estimate is $0 because the app doesn't know your income yet.
      Import bank statements (Spending tab), record a paycheck, or set monthly income in Settings.</p>`;
  }
  if (p.advice && p.advice.suggestions.length) {
    const target = p.advice.target_debt ? esc(p.advice.target_debt) : "your target debt";
    const b = p.advice.boosted;
    const outcome = b.stuck || !b.months
      ? "That's still not enough to reach zero — cut deeper or raise the payments on the stuck debts."
      : `Do all of these and you free <b>${money(p.advice.monthly_freed)}/mo</b> —
         debt-free in <b>${b.months} months</b> (${fmtDate(b.debt_free_date)})` +
        (active.stuck ? " instead of never." : `, paying ${money(b.total_interest)} total interest.`);
    const tierNames = { eliminate: "cut out delivery & in-app buys (90%)", cancel: "cancel subscriptions",
      trim: "trim habits & one-offs", squeeze: "squeeze essentials only if still short" };
    const tiers = ["eliminate", "cancel", "trim", "squeeze"]
      .map((a) => ({ a, sum: p.advice.suggestions.filter((s) => s.action === a)
        .reduce((x, s) => x + s.suggested_cut, 0) }))
      .filter((t) => t.sum > 0);
    html += `<div class="findmoney"><h3>Find the money in your spending</h3>
      <p class="muted small">Easiest first: ${tiers.map((t) => `${tierNames[t.a]} (<b>+${money(t.sum)}/mo</b>)`).join(", then ")}.
        Every dollar goes to <b>${target}</b>.</p>` +
      cutItemsHTML(p.advice.suggestions) +
      `<p class="muted small">${outcome}</p></div>`;
  } else if (active.stuck) {
    html += `<p class="muted small">Import your bank statements on the Spending tab and the app will
      show exactly which spending to cut to fix this.</p>`;
  }
  if (active.timeline && active.timeline.length > 1) {
    html += chartSVG(active.timeline.map((t) => t.total_balance));
  }
  el.innerHTML = html;
  bindKeepButtons(el);
}

// One line per concrete money-saving move: named merchant, how often it's
// hit, example charges, and what stopping it frees up. Every line has a
// "keep" button — press it and that merchant is never suggested again and
// never counted in the freed-money math.
function cutItemsHTML(items) {
  const badge = { cancel: "debt_min", eliminate: "debt_extra", trim: "fun", squeeze: "reserve", review: "emergency" };
  return items.map((s) => `<div class="plan-item">
    <span class="badge ${badge[s.action] || "fun"}">${esc(s.action)}</span>
    <span><span class="what">${esc(s.label)}</span> — ${esc(s.message)}${
      s.examples && s.examples.length
        ? `<br><span class="why">${s.examples.map(esc).join(" · ")}</span>` : ""}</span>
    <span class="amt">${s.suggested_cut > 0 ? "+" + money(s.suggested_cut) + "/mo" : "—"}
      <br><button class="mini ghost" data-keep="${esc(s.label)}" title="I can't / won't cut this — stop suggesting it and stop counting it as freed money">keep</button></span>
  </div>`).join("");
}

function bindKeepButtons(container) {
  container.querySelectorAll("[data-keep]").forEach((b) => b.addEventListener("click", async () => {
    let protectedList = [];
    try { protectedList = JSON.parse(STATE.settings.protected || "[]"); } catch (e) { /* reset */ }
    if (!protectedList.includes(b.dataset.keep)) protectedList.push(b.dataset.keep);
    await api("/api/settings", { protected: JSON.stringify(protectedList) });
    toast(`Kept: ${b.dataset.keep} — it won't be suggested or counted as savings anymore. ` +
      "If it's a bill, also add it on the Bills tab so it's planned.");
    await loadState();
    loadProjection();
    if (typeof loadSpending === "function") loadSpending();
  }));
}

function chartSVG(values) {
  const w = 800, h = 160, pad = 8;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - v / max) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${pts}" fill="none" stroke="#4f8cff" stroke-width="2.5"/>
  </svg><p class="muted small">Total debt balance over time until payoff.</p>`;
}

// ------------------------------------------------------------- bills

function renderBills() {
  const tbody = $("#bill-table tbody");
  if (!STATE.bills.length) {
    tbody.innerHTML = "<tr><td colspan='6' class='muted'>No bills yet — add rent, utilities, insurance, car payment…</td></tr>";
  } else {
    tbody.innerHTML = STATE.bills.map((b) => `<tr>
      <td>${esc(b.name)}</td><td>${esc(b.category)}</td>
      <td class="num">${money(b.amount)}</td><td class="num">${b.due_day}</td>
      <td class="num">${money(b.reserved)}</td>
      <td><button class="mini ghost" data-edit="${b.id}">edit</button>
          <button class="mini danger ghost" data-del="${b.id}">✕</button></td></tr>`).join("");
  }
  const total = STATE.bills.reduce((s, b) => s + b.amount, 0);
  $("#bill-total").textContent = STATE.bills.length ? `Total fixed bills: ${money(total)} / month` : "";
  tbody.querySelectorAll("[data-edit]").forEach((btn) => btn.addEventListener("click", () => {
    const b = STATE.bills.find((x) => x.id == btn.dataset.edit);
    $("#b-id").value = b.id; $("#b-name").value = b.name; $("#b-category").value = b.category;
    $("#b-amount").value = b.amount; $("#b-due").value = b.due_day;
    $("#b-submit").textContent = "Save bill"; $("#b-cancel").style.display = "";
  }));
  tbody.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Delete this bill?")) return;
    await api("/api/bills/delete", { id: Number(btn.dataset.del) });
    await loadState();
  }));
}

// ------------------------------------------------------------- goals

// How much this paycheck cadence needs to set aside per check to hit the date.
function goalPerCheck(g) {
  const today = new Date((STATE.today || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const due = new Date(g.due_date + "T00:00:00");
  const needed = Math.max(0, g.amount - g.saved);
  if (needed <= 0 || due < today) return 0;
  const period = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 }[STATE.settings.pay_frequency] || 14;
  const checks = Math.max(1, Math.floor((due - today) / 86400000 / period) + 1);
  return needed / checks;
}

function renderGoals() {
  const tbody = $("#goal-table tbody");
  const goals = STATE.goals || [];
  if (!goals.length) {
    tbody.innerHTML = "<tr><td colspan='6' class='muted'>Nothing planned — add a purchase and the app will set money aside for it each paycheck.</td></tr>";
    return;
  }
  tbody.innerHTML = goals.map((g) => {
    const done = g.saved >= g.amount - 0.01;
    const late = !done && new Date(g.due_date) < new Date(STATE.today);
    return `<tr>
      <td>${esc(g.name)}${done ? " <span class='badge savings'>ready ✓</span>" : late ? " <span class='badge debt_min'>date passed</span>" : ""}</td>
      <td class="num">${money(g.amount)}</td>
      <td class="num">${money(g.saved)}</td>
      <td>${fmtDate(g.due_date)}</td>
      <td class="num">${done ? "—" : money(goalPerCheck(g))}</td>
      <td><button class="mini danger ghost" data-gdel="${g.id}">✕</button></td></tr>`;
  }).join("");
  tbody.querySelectorAll("[data-gdel]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Remove this planned purchase? (Money already set aside stays in your account.)")) return;
    await api("/api/goals/delete", { id: Number(b.dataset.gdel) });
    await loadState();
  }));
}

$("#goal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/goals", {
    name: $("#g-name").value, amount: $("#g-amount").value, due_date: $("#g-due").value,
  });
  $("#goal-form").reset();
  toast("Purchase planned — each paycheck now sets aside a share.");
  await loadState();
});

$("#bill-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/bills", {
    id: $("#b-id").value ? Number($("#b-id").value) : null,
    name: $("#b-name").value, category: $("#b-category").value,
    amount: $("#b-amount").value, due_day: $("#b-due").value,
  });
  $("#bill-form").reset(); $("#b-id").value = "";
  $("#b-submit").textContent = "Add bill"; $("#b-cancel").style.display = "none";
  toast("Bill saved.");
  await loadState();
});
$("#b-cancel").addEventListener("click", () => {
  $("#bill-form").reset(); $("#b-id").value = "";
  $("#b-submit").textContent = "Add bill"; $("#b-cancel").style.display = "none";
});

// ------------------------------------------------------------- spending

// ---- PDF text extraction (pdf.js, bundled — works offline in the Android app)

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  const inject = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("couldn't load " + src));
    document.head.appendChild(s);
  });
  // Worker script first: it registers window.pdfjsWorker, which pdf.js uses to
  // run on the main thread (real Workers aren't available under file://).
  return inject("pdf.worker.min.js").then(() => inject("pdf.min.js")).then(() => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
  });
}

async function extractPdfText(file) {
  await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await window.pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    // Rebuild layout lines: group text items by y position, sort by x.
    const rows = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      // Skip rotated text (vertical sidebar markers on statements) — it shares
      // a y position with real rows and corrupts them.
      if (Math.abs(item.transform[1]) > 0.01 || Math.abs(item.transform[2]) > 0.01) continue;
      const y = item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x: item.transform[4], s: item.str });
    }
    rows.sort((a, b) => b.y - a.y);
    pages.push(rows.map((r) =>
      r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ")).join("\n"));
  }
  doc.destroy();
  return pages.join("\n");
}

$("#bank-import").addEventListener("click", async () => {
  const files = $("#bank-file").files;
  if (!files.length) { toast("Choose one or more CSV or PDF files first."); return; }
  let added = 0, dupes = 0, notes = [];
  for (const f of files) {
    try {
      let r;
      if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") {
        toast(`Reading ${f.name}…`);
        const text = await extractPdfText(f);
        r = await api("/api/transactions/import", { statement: text });
      } else {
        r = await api("/api/transactions/import", { csv: await f.text() });
      }
      added += r.added; dupes += r.duplicates;
      if (r.note) notes.push(`${f.name}: ${r.note}`);
      if (r.due_day_updates) notes.push(...r.due_day_updates);
      if (!r.parsed && !r.note) {
        notes.push(`${f.name}: no transactions found — check that it has Date and Amount columns.`);
      }
    } catch (err) {
      notes.push(`${f.name}: ${err.message}`);
    }
  }
  $("#bank-import-result").innerHTML =
    `Imported <b>${added}</b> transaction(s)` + (dupes ? `, skipped ${dupes} duplicate(s)` : "") + "." +
    (notes.length ? `<br><span class="small">${notes.map(esc).join("<br>")}</span>` : "");
  $("#bank-file").value = "";
  await loadState(); // due days may have been inferred; dashboard plan changes
  loadSpending();
});

$("#bank-clear").addEventListener("click", async () => {
  if (!confirm("Delete ALL imported transactions?")) return;
  await api("/api/transactions/clear", {});
  toast("Transactions cleared.");
  loadSpending();
});

async function loadSpending() {
  const s = await api("/api/spending?months=6");
  $("#spend-range").textContent = s.months.length ? `(${s.months[0]} → ${s.months[s.months.length - 1]})` : "";

  // category bars
  const catEl = $("#spend-categories");
  if (!s.categories.length) {
    catEl.textContent = "Import a statement to see your breakdown.";
  } else {
    const max = Math.max(...s.categories.map((c) => c.monthly_avg));
    catEl.innerHTML = s.categories.map((c) => `
      <div class="bar-row">
        <span class="name">${esc(c.category)}${c.discretionary ? " ✂️" : ""}</span>
        <div class="bar-track"><div class="bar-fill ${c.discretionary ? "disc" : ""}"
             style="width:${(100 * c.monthly_avg / max).toFixed(1)}%"></div></div>
        <span class="val">${money(c.monthly_avg)}/mo</span>
      </div>`).join("") +
      `<p class="muted small">Average total spend: <b>${money(s.total_monthly_spend)}/mo</b>.
       ✂️ = discretionary. Transfers, debt payments and income are excluded.</p>`;
  }

  // suggestions
  const sugEl = $("#spend-suggestions");
  if (!s.suggestions.length) {
    sugEl.textContent = "No obvious cuts found yet — import more statements for better analysis.";
  } else {
    let html = cutItemsHTML(s.suggestions);
    html += `<div class="okbox">Total potential: <b>${money(s.potential_monthly_savings)}/mo</b>` +
      (s.cut_impact ? ` — put toward debt, that's <b>${s.cut_impact.months_saved} month(s) sooner</b> debt-free and <b>${money(s.cut_impact.interest_saved)}</b> less interest.` : ".") +
      `</div>`;
    sugEl.innerHTML = html;
    bindKeepButtons(sugEl);
  }

  // recurring
  const recEl = $("#spend-recurring");
  recEl.innerHTML = s.recurring.length
    ? s.recurring.map((r) => `<div class="plan-item">
        <span><span class="what">${esc(r.merchant)}</span><br><span class="why">seen in ${r.months_seen} month(s)</span></span>
        <span class="amt">${money(r.monthly_avg)}/mo</span></div>`).join("")
    : "None detected yet.";

  // monthly trend bars
  const trendEl = $("#spend-trend");
  if (s.months.length) {
    const totals = s.months.map((m) => Object.values(s.by_month[m]).reduce((a, b) => a + b, 0));
    const max = Math.max(...totals, 1);
    trendEl.innerHTML = s.months.map((m, i) => `
      <div class="bar-row">
        <span class="name">${m}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(100 * totals[i] / max).toFixed(1)}%"></div></div>
        <span class="val">${money(totals[i])}</span>
      </div>`).join("");
  } else {
    trendEl.textContent = "";
  }

  loadTransactions();
}

async function loadTransactions() {
  const { transactions } = await api("/api/transactions");
  const el = $("#txn-list");
  if (!transactions.length) { el.textContent = "None imported yet."; return; }
  el.innerHTML = `<table class="table"><thead><tr>
      <th>Date</th><th>Description</th><th class="num">Amount</th><th>Category</th></tr></thead><tbody>` +
    transactions.slice(0, 300).map((t) => `<tr>
      <td>${t.date}</td><td>${esc(t.description)}</td>
      <td class="num" style="color:${t.amount < 0 ? "var(--red)" : "var(--green)"}">${money(t.amount)}</td>
      <td><input value="${esc(t.category)}" data-txn="${t.id}" style="width:130px"></td></tr>`).join("") +
    `</tbody></table>` +
    (transactions.length > 300 ? `<p class="muted small">Showing newest 300 of ${transactions.length}.</p>` : "");
  el.querySelectorAll("input[data-txn]").forEach((inp) => inp.addEventListener("change", async () => {
    await api("/api/transactions/category", { id: Number(inp.dataset.txn), category: inp.value });
    toast("Category updated.");
  }));
}

// ------------------------------------------------------------- settings

function renderSettings() {
  const s = STATE.settings;
  $("#s-freq").value = s.pay_frequency;
  $("#s-strategy").value = s.strategy;
  $("#s-variable").value = s.variable_budget;
  $("#s-etarget").value = s.emergency_target;
  $("#s-ebalance").value = s.emergency_balance;
  $("#s-epct").value = s.emergency_pct;
  $("#s-fun").value = s.fun_pct;
  $("#s-income").value = Number(s.monthly_net_income) > 0 ? s.monthly_net_income : "";
  $("#s-income").placeholder = STATE.budget && STATE.budget.monthly_income
    ? `auto: ${STATE.budget.monthly_income} (from paychecks/statements)` : "0";
  loadRules();
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/settings", {
    pay_frequency: $("#s-freq").value,
    strategy: $("#s-strategy").value,
    variable_budget: $("#s-variable").value,
    emergency_target: $("#s-etarget").value,
    emergency_balance: $("#s-ebalance").value,
    emergency_pct: $("#s-epct").value,
    fun_pct: $("#s-fun").value,
    monthly_net_income: $("#s-income").value || "0",
  });
  toast("Settings saved.");
  await loadState();
});

async function loadRules() {
  const { rules } = await api("/api/rules");
  const el = $("#rules-list");
  el.innerHTML = rules.length
    ? rules.map((r) => `<span class="chip">"${esc(r.keyword)}" → ${esc(r.category)}
        <button class="mini danger ghost" data-rule="${r.id}">✕</button></span>`).join(" ")
    : "<p class='muted small'>No custom rules yet.</p>";
  el.querySelectorAll("[data-rule]").forEach((b) => b.addEventListener("click", async () => {
    await api("/api/rules/delete", { id: Number(b.dataset.rule) });
    loadRules();
  }));
}

$("#recategorize").addEventListener("click", async () => {
  const r = await api("/api/transactions/recategorize", {});
  toast(`Re-categorized ${r.changed} transaction(s).`);
  loadSpending();
});

$("#rule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api("/api/rules", { keyword: $("#r-keyword").value, category: $("#r-category").value });
  $("#rule-form").reset();
  loadRules();
});

$("#export-json").addEventListener("click", async () => {
  const data = await api("/api/export");
  download("paydaypilot-backup.json", JSON.stringify(data, null, 2), "application/json");
});

function download(name, content, type) {
  if (window.AndroidBridge && window.AndroidBridge.saveFile) {
    // Android WebView can't download blob: URLs — hand the file to the app.
    window.AndroidBridge.saveFile(name, type, btoa(unescape(encodeURIComponent(content))));
    toast(`Saved ${name} to your Downloads.`);
    return;
  }
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------- boot

if (window.LOCAL_API) $("#quit").style.display = "none"; // nothing to quit in app mode
loadState().catch((e) => toast("Failed to load: " + e.message));
