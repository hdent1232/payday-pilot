/* PayDay Pilot local engine — a full JavaScript port of the Python backend
 * (db + engine + importers + API routes) so the app can run with no server:
 * inside the Android WebView, or by opening index.html straight from disk.
 *
 * Activates only when the page is NOT served over http(s); the desktop app
 * keeps using the Python server. Data lives in localStorage.
 */
"use strict";

(function () {
  if (location.protocol.startsWith("http")) return; // server mode: stay dormant

  // ================================================================ storage

  const STORE_KEY = "paydaypilot";

  const DEFAULT_SETTINGS = {
    pay_frequency: "biweekly",
    strategy: "avalanche",
    emergency_target: "1000",
    emergency_balance: "0",
    emergency_pct: "20",
    fun_pct: "5",
    variable_budget: "600",
    monthly_net_income: "0",
    bank_balance: "",
    bank_balance_updated: "",
    protected: "[]",
  };

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const db = JSON.parse(raw);
        db.goals = db.goals || [];
        // migration: mark previously imported type-default APRs as estimates
        for (const d of db.debts || []) {
          if (d.apr_estimated === undefined) {
            d.apr_estimated = APR_ESTIMATES[d.kind] === d.apr ? 1 : 0;
          }
        }
        return db;
      }
    } catch (e) { /* corrupted store: start fresh */ }
    return { settings: {}, debts: [], bills: [], paychecks: [], transactions: [], rules: [], goals: [], seq: 1 };
  }

  function save(db) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  function nextId(db) {
    return db.seq++;
  }

  function getSettings(db) {
    return Object.assign({}, DEFAULT_SETTINGS, db.settings);
  }

  const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;

  // ================================================================ dates
  // ISO date strings ("YYYY-MM-DD") everywhere; arithmetic via UTC to dodge
  // timezone/DST surprises.

  function toUTC(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function fromUTC(ms) {
    const d = new Date(ms);
    return d.toISOString().slice(0, 10);
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function addDays(iso, days) {
    return fromUTC(toUTC(iso) + days * 86400000);
  }

  function daysBetween(a, b) {
    return Math.round((toUTC(b) - toUTC(a)) / 86400000);
  }

  function addMonths(iso, months) {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    const idx = m - 1 + months;
    const year = y + Math.floor(idx / 12);
    const month = ((idx % 12) + 12) % 12 + 1;
    const day = Math.min(d, 28);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function nextDueDate(dueDay, fromIso) {
    dueDay = Math.max(1, Math.min(28, Number(dueDay) || 1));
    const [y, m, d] = fromIso.slice(0, 10).split("-").map(Number);
    if (d <= dueDay) return `${y}-${String(m).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
    const [yy, mm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    return `${yy}-${String(mm).padStart(2, "0")}-${String(dueDay).padStart(2, "0")}`;
  }

  // ================================================================ engine

  const PERIOD_DAYS = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 };
  const AVG_DAYS_PER_MONTH = 30.44;
  const CHECKS_PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2.0, monthly: 1.0 };

  function checksUntil(due, payDate, freq) {
    const days = daysBetween(payDate, due);
    if (days <= 0) return 1;
    return Math.max(1, Math.floor(days / PERIOD_DAYS[freq]) + 1);
  }

  function pickTargetDebt(debts, strategy) {
    const active = debts.filter((d) => d.balance > 0.01);
    if (!active.length) return null;
    if (strategy === "snowball") {
      return active.reduce((a, b) => (b.balance < a.balance ? b : a));
    }
    return active.reduce((a, b) =>
      (b.apr > a.apr || (b.apr === a.apr && b.balance > a.balance)) ? b : a);
  }

  function buildPlan(amount, payDate, bills, debts, settings, goals) {
    const freq = settings.pay_frequency;
    const strategy = settings.strategy;
    const period = PERIOD_DAYS[freq];
    const windowEnd = addDays(payDate, period);

    let remaining = r2(amount);
    const items = [];
    const warnings = [];
    const reserveUpdates = {};
    const goalUpdates = {};

    const obligations = [];
    // past-due catch-ups: due NOW, before everything
    for (const d of debts) {
      const pastDue = Math.min(Number(d.past_due) || 0, d.balance);
      if (pastDue > 0.01) {
        obligations.push({ kind: "debt_catchup", ref: d, due: payDate, share: r2(pastDue), dueNow: true });
      }
    }
    for (const b of bills) {
      const due = nextDueDate(b.due_day, payDate);
      const needed = Math.max(0, b.amount - b.reserved);
      const n = checksUntil(due, payDate, freq);
      const dueNow = due < windowEnd;
      obligations.push({ kind: "bill", ref: b, due, share: dueNow ? needed : r2(needed / n), dueNow });
    }
    for (const d of debts) {
      if (d.balance <= 0.01 || d.min_payment <= 0) continue;
      const due = nextDueDate(d.due_day, payDate);
      const payment = Math.min(d.min_payment, d.balance);
      const n = checksUntil(due, payDate, freq);
      const dueNow = due < windowEnd;
      obligations.push({ kind: "debt_min", ref: d, due, share: dueNow ? payment : r2(payment / n), dueNow });
    }
    for (const g of goals || []) {
      const needed = Math.max(0, g.amount - g.saved);
      const due = (g.due_date || "").slice(0, 10);
      if (needed <= 0.01 || !due || due < payDate) continue;
      const n = checksUntil(due, payDate, freq);
      const dueNow = due < windowEnd;
      obligations.push({ kind: "goal", ref: g, due, share: dueNow ? needed : r2(needed / n), dueNow });
    }
    obligations.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : b.share - a.share));

    for (const ob of obligations) {
      if (ob.share < 0.01) continue;
      const alloc = r2(Math.min(ob.share, remaining));
      const ref = ob.ref;
      if (alloc < ob.share - 0.01) {
        warnings.push(`Not enough left to fully cover ${ref.name} ` +
          `(needed $${ob.share.toFixed(2)}, allocated $${alloc.toFixed(2)}).`);
      }
      remaining = r2(remaining - alloc);
      if (ob.kind === "bill") {
        if (ob.dueNow) {
          const payAmount = r2(Math.min(ref.amount, ref.reserved + alloc));
          let note = `due ${ob.due}`;
          if (ref.reserved > 0.01) note += ` ($${ref.reserved.toFixed(2)} already set aside)`;
          reserveUpdates[ref.id] = 0;
          items.push({ action: `Pay ${ref.name}`, amount: payAmount, from_paycheck: alloc,
            kind: "bill", category: ref.category, due: ob.due, note });
        } else {
          reserveUpdates[ref.id] = r2(ref.reserved + alloc);
          if (alloc >= 0.01) {
            items.push({ action: `Set aside for ${ref.name}`, amount: alloc, from_paycheck: alloc,
              kind: "reserve", category: ref.category, due: ob.due,
              note: `$${reserveUpdates[ref.id].toFixed(2)} of $${ref.amount.toFixed(2)} ` +
                    `saved for the ${ob.due} bill` });
          }
        }
      } else if (ob.kind === "debt_catchup") {
        if (alloc >= 0.01) {
          items.push({ action: `CATCH UP ${ref.name}`, amount: alloc, from_paycheck: alloc,
            kind: "catchup", category: "Debt", due: ob.due,
            note: `$${ob.share.toFixed(2)} past due — paid before everything else`, debt_id: ref.id });
        }
      } else if (ob.kind === "goal") {
        const newSaved = r2(ref.saved + alloc);
        goalUpdates[ref.id] = newSaved;
        if (alloc >= 0.01) {
          items.push({ action: `Set aside for ${ref.name}`, amount: alloc, from_paycheck: alloc,
            kind: "goal", category: "Goals", due: ob.due,
            note: `$${newSaved.toFixed(2)} of $${ref.amount.toFixed(2)} saved — needed by ${ob.due}`,
            goal_id: ref.id });
        }
      } else if (alloc >= 0.01) {
        const verb = ob.dueNow ? "Pay" : "Set aside for";
        items.push({ action: `${verb} ${ref.name} (minimum)`, amount: alloc, from_paycheck: alloc,
          kind: "debt_min", category: "Debt", due: ob.due,
          note: `minimum payment, due ${ob.due}`, debt_id: ref.id });
      }
      if (remaining <= 0) remaining = 0;
    }

    const variableBudget = Number(settings.variable_budget);
    const essentials = r2(variableBudget * period / AVG_DAYS_PER_MONTH);
    if (essentials > 0.01) {
      const alloc = r2(Math.min(essentials, remaining));
      if (alloc < essentials - 0.01) {
        warnings.push(`Essentials budget is short: $${alloc.toFixed(2)} of $${essentials.toFixed(2)} ` +
          `for groceries/gas until the next paycheck.`);
      }
      if (alloc >= 0.01) {
        items.push({ action: "Keep for essentials", amount: alloc, from_paycheck: alloc,
          kind: "essentials", category: "Essentials", due: "",
          note: `groceries, gas & day-to-day spending for the next ${period} days` });
      }
      remaining = r2(remaining - alloc);
    }

    const target = Number(settings.emergency_target);
    const balance = Number(settings.emergency_balance);
    let emergencyAlloc = 0;
    if (remaining > 0.01 && balance < target) {
      const pct = Number(settings.emergency_pct) / 100;
      emergencyAlloc = r2(Math.min(target - balance, remaining * pct));
      if (emergencyAlloc >= 0.01) {
        items.push({ action: "Move to emergency fund", amount: emergencyAlloc,
          from_paycheck: emergencyAlloc, kind: "emergency", category: "Savings", due: "",
          note: `fund at $${(balance + emergencyAlloc).toFixed(2)} of $${target.toFixed(2)} target` });
        remaining = r2(remaining - emergencyAlloc);
      } else {
        emergencyAlloc = 0;
      }
    }

    let fun = 0;
    if (remaining > 0.01) {
      fun = r2(remaining * Number(settings.fun_pct) / 100);
      if (fun >= 0.01) {
        items.push({ action: "Fun money", amount: fun, from_paycheck: fun,
          kind: "fun", category: "Fun", due: "",
          note: "guilt-free spending so the plan is sustainable" });
        remaining = r2(remaining - fun);
      } else {
        fun = 0;
      }
    }

    let extra = 0;
    const targetDebt = pickTargetDebt(debts, strategy);
    if (remaining > 0.01) {
      if (targetDebt) {
        extra = remaining;
        items.push({ action: `EXTRA payment to ${targetDebt.name}`, amount: extra,
          from_paycheck: extra, kind: "debt_extra", category: "Debt", due: "",
          debt_id: targetDebt.id,
          note: `${strategy} target — ${targetDebt.apr.toFixed(2)}% APR, ` +
                `$${targetDebt.balance.toFixed(2)} balance` });
      } else {
        items.push({ action: "Move to savings", amount: remaining, from_paycheck: remaining,
          kind: "savings", category: "Savings", due: "",
          note: "no active debts — build savings or invest" });
      }
      remaining = 0;
    }

    const sum = (kinds) => r2(items.filter((i) => kinds.includes(i.kind))
      .reduce((s, i) => s + i.from_paycheck, 0));
    const totalAllocated = sum(["bill", "reserve", "debt_min", "debt_extra", "essentials", "emergency", "fun", "savings"]);
    return {
      pay_date: payDate,
      amount: r2(amount),
      window_days: period,
      next_paycheck_expected: windowEnd,
      items,
      warnings,
      totals: {
        bills: sum(["bill", "reserve"]),
        debt_min: sum(["debt_min"]),
        catch_up: sum(["catchup"]),
        goals: sum(["goal"]),
        debt_extra: extra,
        essentials: sum(["essentials"]),
        emergency: emergencyAlloc,
        fun,
        savings: sum(["savings"]),
        allocated: totalAllocated,
        unallocated: r2(amount - totalAllocated),
      },
      reserve_updates: reserveUpdates,
      goal_updates: goalUpdates,
      target_debt: targetDebt ? targetDebt.name : null,
      strategy,
    };
  }

  function simulatePayoff(debts, strategy, monthlyExtra, start) {
    start = start || todayISO();
    const balances = {};
    const info = {};
    for (const d of debts) {
      if (d.balance > 0.01) { balances[d.id] = d.balance; info[d.id] = d; }
    }
    if (!Object.keys(balances).length) {
      return { months: 0, total_interest: 0, debt_free_date: start, payoff_order: [], timeline: [], stuck: false };
    }
    let totalInterest = 0;
    const payoffOrder = [];
    const timeline = [];
    let month = 0;
    let freedMinimums = 0;

    while (Object.keys(balances).length && month < 720) {
      month += 1;
      for (const id of Object.keys(balances)) {
        const interest = balances[id] * info[id].apr / 100 / 12;
        balances[id] += interest;
        totalInterest += interest;
      }
      for (const id of Object.keys(balances)) {
        balances[id] -= Math.min(info[id].min_payment, balances[id]);
      }
      let budget = monthlyExtra + freedMinimums;
      while (budget > 0.005 && Object.keys(balances).length) {
        const active = Object.keys(balances).map((id) =>
          Object.assign({}, info[id], { balance: balances[id] }));
        const target = pickTargetDebt(active, strategy);
        if (!target) break;
        const pay = Math.min(budget, balances[target.id]);
        balances[target.id] -= pay;
        budget -= pay;
      }
      for (const id of Object.keys(balances)) {
        if (balances[id] <= 0.005) {
          freedMinimums += info[id].min_payment;
          payoffOrder.push({ name: info[id].name, month, date: addMonths(start, month) });
          delete balances[id];
        }
      }
      timeline.push({ month, date: addMonths(start, month),
        total_balance: r2(Object.values(balances).reduce((a, b) => a + b, 0)) });
    }
    const stuck = Object.keys(balances).length > 0;
    return {
      months: stuck ? null : month,
      total_interest: r2(totalInterest),
      debt_free_date: stuck ? null : addMonths(start, month),
      payoff_order: payoffOrder,
      timeline,
      stuck,
      // why the plan never finishes: debts nothing is paid toward vs debts
      // whose interest outruns their payment
      stuck_debts: Object.keys(balances).map((id) => ({
        name: info[id].name,
        reason: info[id].min_payment <= 0.005 ? "no_payment" : "interest",
      })),
    };
  }

  // Pay cadence learned from paycheck history: median gap between checks,
  // typical (median) amount, and the predicted next payday. Needs >= 3 checks.
  function paycheckPattern(paychecks) {
    if (paychecks.length < 3) return null;
    const dates = paychecks.map((p) => p.date).sort().slice(-10);
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
      const g = Math.round((new Date(dates[i] + "T00:00:00") - new Date(dates[i - 1] + "T00:00:00")) / 86400000);
      if (g >= 1 && g <= 45) gaps.push(g);
    }
    if (!gaps.length) return null;
    gaps.sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    let frequency = "biweekly", best = 99;
    for (const [f, days] of Object.entries(PERIOD_DAYS)) {
      if (Math.abs(days - gap) < best) { best = Math.abs(days - gap); frequency = f; }
    }
    const amounts = paychecks.slice(0, 6).map((p) => p.amount).sort((a, b) => a - b);
    const next = new Date(dates[dates.length - 1] + "T00:00:00");
    next.setDate(next.getDate() + gap);
    return {
      gap_days: gap, frequency,
      typical_amount: r2(amounts[Math.floor(amounts.length / 2)]),
      next_payday: next.toISOString().slice(0, 10),
      checks_seen: paychecks.length,
    };
  }

  // Income source, in order: the Settings value, the learned pay pattern,
  // recorded paychecks, then Income deposits from imported bank statements.
  function estimateMonthlyExtra(bills, debts, settings, recentPaychecks, transactions) {
    let income = Number(settings.monthly_net_income);
    const pattern = recentPaychecks.length ? paycheckPattern(recentPaychecks) : null;
    if (income <= 0 && pattern) {
      income = pattern.typical_amount * AVG_DAYS_PER_MONTH / pattern.gap_days;
    }
    if (income <= 0 && recentPaychecks.length) {
      const checks = recentPaychecks.slice(0, 8);
      const avg = checks.reduce((s, p) => s + p.amount, 0) / checks.length;
      income = avg * CHECKS_PER_MONTH[settings.pay_frequency];
    }
    if (income <= 0 && transactions && transactions.length) {
      const byMonth = {};
      for (const t of transactions) {
        if (t.amount > 0 && t.category === "Income") {
          const m = t.date.slice(0, 7);
          byMonth[m] = (byMonth[m] || 0) + t.amount;
        }
      }
      const months = Object.keys(byMonth).sort().slice(-3);
      if (months.length) {
        income = months.reduce((s, m) => s + byMonth[m], 0) / months.length;
      }
    }
    const billsTotal = bills.reduce((s, b) => s + b.amount, 0);
    const minsTotal = debts.reduce((s, d) =>
      s + (d.balance > 0.01 ? Math.min(d.min_payment, d.balance) : 0), 0);
    const variable = Number(settings.variable_budget);
    const leftover = income - billsTotal - minsTotal - variable;
    const fun = Math.max(0, leftover) * Number(settings.fun_pct) / 100;
    return {
      monthly_income: r2(income),
      monthly_bills: r2(billsTotal),
      monthly_debt_minimums: r2(minsTotal),
      monthly_essentials: r2(variable),
      monthly_fun: r2(fun),
      monthly_extra: r2(Math.max(0, leftover - fun)),
      pattern,
    };
  }

  function compareStrategies(debts, monthlyExtra) {
    return {
      minimum_only: simulatePayoff(debts, "avalanche", 0),
      snowball: simulatePayoff(debts, "snowball", monthlyExtra),
      avalanche: simulatePayoff(debts, "avalanche", monthlyExtra),
    };
  }

  // ================================================================ importers

  const DEFAULT_RULES = [
    ["rent", "Housing"], ["mortgage", "Housing"], ["apartment", "Housing"],
    ["electric", "Utilities"], ["energy", "Utilities"], ["power", "Utilities"],
    ["water", "Utilities"], ["sewer", "Utilities"], ["gas co", "Utilities"],
    ["internet", "Utilities"], ["wifi", "Utilities"], ["comcast", "Utilities"],
    ["xfinity", "Utilities"], ["spectrum", "Utilities"], ["cox ", "Utilities"],
    ["verizon", "Phone"], ["t-mobile", "Phone"], ["tmobile", "Phone"], ["at&t", "Phone"],
    ["kroger", "Groceries"], ["walmart", "Groceries"], ["aldi", "Groceries"],
    ["costco", "Groceries"], ["trader joe", "Groceries"], ["publix", "Groceries"],
    ["safeway", "Groceries"], ["heb ", "Groceries"], ["wegmans", "Groceries"],
    ["whole foods", "Groceries"], ["grocery", "Groceries"], ["food lion", "Groceries"],
    ["shell", "Gas & Fuel"], ["chevron", "Gas & Fuel"], ["exxon", "Gas & Fuel"],
    ["bp ", "Gas & Fuel"], ["speedway", "Gas & Fuel"], ["circle k", "Gas & Fuel"],
    ["marathon", "Gas & Fuel"], ["fuel", "Gas & Fuel"],
    ["uber eats", "Dining"], ["uber * eats", "Dining"], ["uber *eats", "Dining"],
    ["ubereats", "Dining"],  // before the generic "uber" transport rule
    ["uber", "Transport"], ["lyft", "Transport"], ["parking", "Transport"],
    ["toll", "Transport"], ["transit", "Transport"],
    ["netflix", "Subscriptions"], ["spotify", "Subscriptions"], ["hulu", "Subscriptions"],
    ["disney", "Subscriptions"], ["youtube", "Subscriptions"], ["apple.com", "Subscriptions"],
    ["prime video", "Subscriptions"], ["audible", "Subscriptions"], ["patreon", "Subscriptions"],
    ["onlyfans", "Subscriptions"], ["hbo", "Subscriptions"], ["paramount", "Subscriptions"],
    ["mcdonald", "Dining"], ["starbucks", "Dining"], ["chipotle", "Dining"],
    ["chick-fil-a", "Dining"], ["taco bell", "Dining"], ["wendy", "Dining"],
    ["burger", "Dining"], ["pizza", "Dining"], ["doordash", "Dining"],
    ["grubhub", "Dining"], ["ubereats", "Dining"], ["uber eats", "Dining"],
    ["restaurant", "Dining"], ["cafe", "Dining"], ["diner", "Dining"], ["bar & grill", "Dining"],
    ["amazon", "Shopping"], ["target", "Shopping"], ["best buy", "Shopping"],
    ["ebay", "Shopping"], ["etsy", "Shopping"], ["temu", "Shopping"], ["shein", "Shopping"],
    ["gym", "Health & Fitness"], ["planet fitness", "Health & Fitness"],
    ["la fitness", "Health & Fitness"], ["pharmacy", "Health & Fitness"],
    ["cvs", "Health & Fitness"], ["walgreens", "Health & Fitness"],
    ["doctor", "Health & Fitness"], ["dental", "Health & Fitness"],
    ["geico", "Insurance"], ["progressive", "Insurance"], ["state farm", "Insurance"],
    ["allstate", "Insurance"], ["insurance", "Insurance"], ["root ins", "Insurance"],
    ["prog ", "Insurance"], ["prog*", "Insurance"], ["prgrsv", "Insurance"],
    ["ins prem", "Insurance"], ["ins premium", "Insurance"],
    ["lemonade", "Insurance"], ["usaa", "Insurance"], ["liberty mutual", "Insurance"],
    ["farmers ins", "Insurance"], ["nationwide", "Insurance"], ["the general", "Insurance"],
    ["gainsco", "Insurance"],
    ["discount tire", "Car & Maintenance"], ["firestone", "Car & Maintenance"],
    ["jiffy lube", "Car & Maintenance"], ["take 5", "Car & Maintenance"],
    ["valvoline", "Car & Maintenance"], ["strickland", "Car & Maintenance"],
    ["autozone", "Car & Maintenance"], ["o'reilly", "Car & Maintenance"],
    ["oreilly", "Car & Maintenance"], ["advance auto", "Car & Maintenance"],
    ["pep boys", "Car & Maintenance"], ["oil change", "Car & Maintenance"],
    ["tire", "Car & Maintenance"], ["car wash", "Car & Maintenance"],
    ["turbotax", "Taxes & Fees"], ["intuit", "Taxes & Fees"], ["h&r block", "Taxes & Fees"],
    ["irs treas", "Taxes & Fees"], ["tax payment", "Taxes & Fees"],
    ["hinge", "Subscriptions"], ["tinder", "Subscriptions"], ["bumble", "Subscriptions"],
    ["chime", "Transfers"], ["varo", "Transfers"], ["apple cash", "Transfers"],
    ["discover e-pay", "Debt Payment"], ["discover payment", "Debt Payment"],
    ["steam", "Entertainment"], ["playstation", "Entertainment"], ["xbox", "Entertainment"],
    ["cinema", "Entertainment"], ["theatre", "Entertainment"], ["ticketmaster", "Entertainment"],
    ["365 market", "Dining"], ["aramark", "Dining"], ["waffle house", "Dining"],
    ["favor ", "Dining"], ["texaco", "Gas & Fuel"], ["valero", "Gas & Fuel"],
    ["7-eleven", "Gas & Fuel"], ["openai", "Subscriptions"], ["chatgpt", "Subscriptions"],
    ["rocketmoney", "Subscriptions"], ["rkt money", "Subscriptions"],
    ["xsolla", "Entertainment"], ["whop", "Entertainment"],
    ["hims", "Health & Fitness"], ["crunch fit", "Health & Fitness"],
    ["westlake", "Debt Payment"], ["uas epayment", "Debt Payment"],
    ["payroll", "Income"], ["direct dep", "Income"], ["paycheck", "Income"], ["salary", "Income"],
    ["dividend", "Income"],
    ["car payment", "Debt Payment"], ["loan pmt", "Debt Payment"], ["loan payment", "Debt Payment"],
    ["credit card pmt", "Debt Payment"], ["card payment", "Debt Payment"], ["autopay", "Debt Payment"],
    ["transfer", "Transfers"], ["zelle", "Transfers"], ["venmo", "Transfers"],
    ["cash app", "Transfers"], ["paypal", "Transfers"], ["atm", "Cash"],
  ];

  const DISCRETIONARY = new Set(["Dining", "Subscriptions", "Shopping", "Entertainment", "Other", "Cash"]);
  const ESSENTIAL_RECURRING = new Set(["Housing", "Utilities", "Phone", "Insurance", "Groceries",
    "Gas & Fuel", "Debt Payment", "Transfers", "Income", "Car & Maintenance", "Taxes & Fees"]);

  // Words too generic to identify a debt by ("SERVICES" would match anything).
  const GENERIC_DEBT_WORDS = new Set(["service", "services", "financia", "financial", "national",
    "credit", "america", "united", "collect", "collecti", "account", "payment", "bank"]);

  function debtKeywords(name) {
    return ((name || "").match(/[A-Za-z]{6,}/g) || [])
      .map((w) => w.slice(0, 8).toLowerCase())
      .filter((w) => !GENERIC_DEBT_WORDS.has(w));
  }

  // Payments toward tracked debts are Debt Payment, never cuttable spending.
  function debtPaymentRules(debts) {
    const rules = [];
    for (const d of debts) {
      for (const kw of debtKeywords(d.name)) rules.push({ keyword: kw, category: "Debt Payment" });
    }
    return rules;
  }

  function mergeRules(userRules, debts) {
    return userRules.map((r) => ({ keyword: r.keyword.toLowerCase(), category: r.category }))
      .concat(debts ? debtPaymentRules(debts) : [])
      .concat(DEFAULT_RULES.map(([k, c]) => ({ keyword: k, category: c })));
  }

  // Debt due days from the days their payments actually post: the median
  // day-of-month of the payments toward each debt.
  function inferDebtDueDays(debts, transactions) {
    const out = {};
    for (const d of debts) {
      const kws = debtKeywords(d.name);
      if (!kws.length) continue;
      const days = transactions
        .filter((t) => t.amount < 0 && kws.some((k) => t.description.toLowerCase().includes(k)))
        .map((t) => Number(t.date.slice(8, 10)))
        .sort((a, b) => a - b);
      if (days.length >= 2) out[d.id] = Math.min(28, days[Math.floor(days.length / 2)]);
    }
    return out;
  }

  function categorize(description, rules) {
    const desc = description.toLowerCase();
    for (const r of rules) if (desc.includes(r.keyword)) return r.category;
    return "Other";
  }

  function parseCSV(text) {
    // Small RFC-4180-ish parser: quoted fields, embedded commas/newlines.
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  }

  const DATE_COLS = ["date", "transaction date", "trans date", "posted date", "posting date", "post date"];
  const DESC_COLS = ["description", "memo", "payee", "name", "details", "merchant", "transaction"];
  const AMOUNT_COLS = ["amount", "transaction amount", "amt"];
  const DEBIT_COLS = ["debit", "withdrawal", "withdrawals", "money out", "outflow"];
  const CREDIT_COLS = ["credit", "deposit", "deposits", "money in", "inflow"];

  function parseAnyDate(value) {
    value = value.trim();
    let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      let [, mo, d, y] = m;
      if (y.length === 2) y = (Number(y) > 70 ? "19" : "20") + y;
      if (Number(mo) > 12 && Number(d) <= 12) [mo, d] = [d, mo]; // d/m/y statements
      if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    const parsed = new Date(value);
    if (!isNaN(parsed) && /[a-zA-Z]/.test(value)) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }
    return null;
  }

  function parseMoney(value) {
    value = String(value ?? "").trim().replace(/\$/g, "").replace(/,/g, "");
    if (!value) return null;
    const negative = value.startsWith("(") && value.endsWith(")");
    value = value.replace(/^\(|\)$/g, "");
    const num = Number(value);
    if (isNaN(num)) return null;
    return negative ? -num : num;
  }

  function findCol(header, candidates) {
    const lowered = header.map((h) => h.trim().toLowerCase());
    for (const cand of candidates) {
      const i = lowered.indexOf(cand);
      if (i !== -1) return i;
    }
    for (const cand of candidates) {
      const i = lowered.findIndex((h) => h.includes(cand));
      if (i !== -1) return i;
    }
    return null;
  }

  function parseBankCsv(text, rules) {
    const lines = parseCSV(text);
    if (!lines.length) return [[], "File is empty."];
    const header = lines[0];
    const di = findCol(header, DATE_COLS);
    if (di === null) return [[], "Couldn't find a date column. Expected a header row with a 'Date' column."];
    const descI = findCol(header, DESC_COLS);
    const amtI = findCol(header, AMOUNT_COLS);
    const debitI = findCol(header, DEBIT_COLS);
    const creditI = findCol(header, CREDIT_COLS);
    if (amtI === null && debitI === null && creditI === null) {
      return [[], "Couldn't find an Amount (or Debit/Credit) column."];
    }
    const txns = [];
    let skipped = 0;
    for (const row of lines.slice(1)) {
      if (row.length <= di) { skipped++; continue; }
      const d = parseAnyDate(row[di]);
      if (!d) { skipped++; continue; }
      const desc = descI !== null && row.length > descI ? row[descI].trim() : "Transaction";
      let amount = null;
      if (amtI !== null && row.length > amtI) amount = parseMoney(row[amtI]);
      if (amount === null) {
        const debit = debitI !== null && row.length > debitI ? parseMoney(row[debitI]) : null;
        const credit = creditI !== null && row.length > creditI ? parseMoney(row[creditI]) : null;
        if (debit) amount = -Math.abs(debit);
        else if (credit) amount = Math.abs(credit);
      }
      if (amount === null) { skipped++; continue; }
      let category = categorize(desc, rules);
      if (amount > 0 && category === "Other") category = "Income";
      txns.push({ date: d, description: desc, amount: r2(amount), category });
    }
    return [txns, skipped ? `Skipped ${skipped} unparseable row(s).` : ""];
  }

  // ---------------------------------------------- PDF statement text parsing
  // Mirrors app/importers.py parse_statement_text — see there for the details.

  const MONEY_TOKEN = "-?\\(?\\$?-?[\\d,]{1,12}\\.\\d{2}\\)?";
  const STMT_LINE = new RegExp(
    "^\\s*(\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)" +
    "(?:\\s+(\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?))?" +
    "\\s+(.+?)" +
    `\\s+(${MONEY_TOKEN}(?:\\s+${MONEY_TOKEN})*)\\s*$`);
  const STMT_SKIP_ON = /core fund activity|estimated cash flow|^holdings\b/i;
  const STMT_SKIP_OFF = /deposits|withdrawals|debit card|purchases|other card activity|dividends|checks paid|atm|transactions/i;
  const STMT_NEG_SECTION = /withdrawal|purchase|checks? paid|fees|debits|atm/i;
  const STMT_POS_SECTION = /deposit|credit|addition|dividend|interest|other card activity/i;
  const STMT_BAD_DESC = /you sold|you bought|morning trade|reinvest/i;
  const STMT_BAD_START = ["total", "subtotal", "beginning", "ending", "balance", "date", "trans."];
  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july",
    "august", "september", "october", "november", "december"];

  function statementPeriodEnd(text) {
    const monthAlt = MONTH_NAMES.map((m) => m[0].toUpperCase() + m.slice(1)).join("|");
    let m = text.match(new RegExp(
      `(?:${monthAlt})\\s+\\d{1,2},\\s*\\d{4}\\s*[-–—]\\s*` +
      `(${monthAlt})\\s+(\\d{1,2}),\\s*(\\d{4})`, "i"));
    if (m) {
      const month = MONTH_NAMES.indexOf(m[1].toLowerCase()) + 1;
      return `${m[3]}-${String(month).padStart(2, "0")}-${String(Math.min(28, Number(m[2]))).padStart(2, "0")}`;
    }
    m = text.match(/\d{1,2}\/\d{1,2}\/(\d{2,4})\s*(?:-|–|—|to|through)\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      let year = Number(m[4]);
      if (year < 100) year += 2000;
      const mo = Number(m[2]), d = Number(m[3]);
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
    return null;
  }

  function statementDate(token, periodEnd) {
    const parts = token.split("/").map(Number);
    const [month, day] = parts;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (parts.length === 3) {
      let year = parts[2];
      if (year < 100) year += 2000;
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    const ref = periodEnd || todayISO();
    const refYear = Number(ref.slice(0, 4));
    for (const year of [refYear, refYear - 1]) {
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (toUTC(iso) <= toUTC(ref) + 35 * 86400000) return iso;
    }
    return null;
  }

  function parseStatementText(text, rules) {
    const periodEnd = statementPeriodEnd(text);
    const txns = [];
    let skipping = false;
    let sectionSign = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(STMT_LINE);
      if (!m) {
        if (line.length < 80) {
          if (STMT_SKIP_ON.test(line)) skipping = true;
          else if (STMT_SKIP_OFF.test(line)) {
            skipping = false;
            if (STMT_NEG_SECTION.test(line)) sectionSign = -1;
            else if (STMT_POS_SECTION.test(line)) sectionSign = 1;
          }
        }
        continue;
      }
      if (skipping) continue;
      const [, date1, date2, descRaw, moneyGroup] = m;
      const desc = descRaw.replace(/\s+/g, " ").trim();
      const low = desc.toLowerCase();
      if (!desc || STMT_BAD_START.some((s) => low.startsWith(s)) || STMT_BAD_DESC.test(low)) continue;
      const tokens = moneyGroup.split(/\s+/);
      const rawAmount = tokens.length >= 2 ? tokens[tokens.length - 2] : tokens[tokens.length - 1];
      let amount = parseMoney(rawAmount);
      if (amount === null) continue;
      if (amount > 0 && !rawAmount.includes("-") && !rawAmount.includes("(") && sectionSign < 0) {
        amount = -amount;
      }
      const when = statementDate(date2 || date1, periodEnd);
      if (!when) continue;
      txns.push({ date: when, description: desc.slice(0, 120), amount: r2(amount),
        category: categorize(desc, rules) });
    }
    const note = txns.length ? "" :
      "No transactions found. If this statement is a scanned image (not selectable text), it can't be read.";
    return [txns, note];
  }

  const DEBT_NAME_COLS = ["name", "account", "account name", "creditor", "lender"];
  const DEBT_BALANCE_COLS = ["balance", "amount owed", "current balance", "owed"];
  const DEBT_APR_COLS = ["apr", "interest rate", "rate", "interest"];
  const DEBT_MIN_COLS = ["min payment", "minimum payment", "monthly payment", "payment", "min_payment"];
  const DEBT_TERM_COLS = ["term", "term months", "months", "term_months"];
  const DEBT_DUE_COLS = ["due day", "due", "due_day"];

  const KNOWN_CREDITORS = [
    "capital one", "chase", "discover", "amex", "american express", "citi", "citibank",
    "bank of america", "wells fargo", "synchrony", "credit one", "usaa", "navy federal",
    "us bank", "barclays", "goldman", "apple card", "affirm", "klarna", "afterpay",
    "upstart", "sofi", "lending club", "avant", "onemain", "ally", "santander",
    "toyota financial", "honda financial", "gm financial", "ford credit", "carmax",
    "nelnet", "navient", "mohela", "great lakes", "fedloan", "sallie mae", "earnest",
    "aidvantage", "student loan", "auto loan", "car loan", "personal loan", "medical",
    "credit card", "visa", "mastercard",
  ];

  function parseDebtsCsv(text) {
    const lines = parseCSV(text);
    if (lines.length < 2) return [];
    const header = lines[0];
    const ni = findCol(header, DEBT_NAME_COLS);
    const bi = findCol(header, DEBT_BALANCE_COLS);
    if (ni === null || bi === null) return [];
    const ai = findCol(header, DEBT_APR_COLS);
    const mi = findCol(header, DEBT_MIN_COLS);
    const ti = findCol(header, DEBT_TERM_COLS);
    const dui = findCol(header, DEBT_DUE_COLS);
    const cell = (row, i) => (i !== null && row.length > i ? row[i].trim() : "");

    const debts = [];
    for (const row of lines.slice(1)) {
      const name = cell(row, ni);
      const balance = parseMoney(cell(row, bi));
      if (!name || balance === null) continue;
      const term = cell(row, ti);
      const due = cell(row, dui);
      debts.push({
        name,
        balance: Math.abs(balance),
        apr: parseMoney(cell(row, ai).replace("%", "")) || 0,
        min_payment: Math.abs(parseMoney(cell(row, mi)) || 0),
        term_months: term ? Math.trunc(Number(term)) : null,
        due_day: due ? Math.trunc(Number(due)) : 1,
        kind: "other",
      });
    }
    return debts;
  }

  const MONEY_RE = "\\$?\\s?([\\d,]+(?:\\.\\d{1,2})?)";

  function parseDebtsText(text) {
    const found = [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      const creditor = KNOWN_CREDITORS.find((c) => low.includes(c)) || null;
      // Detail lines ("Balance: $X", "APR: Y%") describe the account named
      // above them — they are context, not accounts of their own.
      if (!creditor && /^(balance|amount|owed|apr|interest|min(imum)?|monthly|payment)\b/.test(low)) continue;
      let balanceM = low.match(new RegExp("(?:balance|owed|amount)\\D{0,12}" + MONEY_RE));
      if (!creditor && !balanceM) continue;
      const context = lines.slice(i, i + 4).join(" ").toLowerCase();
      balanceM = balanceM || context.match(new RegExp("(?:balance|owed|amount)\\D{0,12}" + MONEY_RE));
      if (!balanceM) {
        const money = context.match(new RegExp(MONEY_RE));
        balanceM = creditor && money ? money : null;
      }
      if (!balanceM) continue;
      const balance = Number(balanceM[1].replace(/,/g, ""));
      const aprM = context.match(/([\d.]+)\s?%/);
      const minM = context.match(new RegExp("(?:min(?:imum)?|monthly)\\s?(?:payment|pmt)\\D{0,12}" + MONEY_RE));
      const entry = {
        name: line.replace(/\s+/g, " ").slice(0, 60),
        balance,
        apr: aprM ? Number(aprM[1]) : 0,
        min_payment: minM ? Number(minM[1].replace(/,/g, "")) : 0,
        term_months: null, due_day: 1, kind: "other",
      };
      if (found.every((f) => Math.abs(f.balance - balance) > 0.01 || f.name !== entry.name)) {
        found.push(entry);
      }
    }
    return found;
  }

  // Bureau/tenant-screening reports (Experian, SafeRent, RentGrow, …) lay out
  // each account as a "CREDITOR - Member # 123" header followed by labeled
  // fields. pdf.js flattens the two-column layout into single lines, so fields
  // are found by label anywhere in the account's block, not by position.
  const CR_LABELS = "(?:Reported|Type|Industry|Account\\s*#|High Credit|Credit Limit|Payment|" +
    "Past Due|Balance|Months Reviewed|Last Activity|Original Loan Amount|ECOA|Narrative|Opened|" +
    "Status|Date Reported|Agency Customer\\s*#|Balance Due|Past Due Amount|Balance Date|" +
    "Account/Serial\\s*#|Collection Agency|Original Amount Owed)\\s*:";
  const CR_TRADELINE_HEAD = /^[ \t\f]*(\S[^\n]{1,60}?)\s*[-–]\s*Member\s*#/gm;
  const CR_SECTION_END = /\b(?:Inquiries|Collections|Credit Report Serviced)\b/;
  const CR_STUDENT = ["college", "studen", "sallie", "navient", "nelnet", "mohela",
    "edfinancial", "aidvantage", "fedloan", "great lakes", "earnest", "uas"];
  const CR_AUTO = ["auto", "westlake", "toyota", "honda", "gm financial", "ford credit",
    "carmax", "car loan", "vehicle"];

  function crMoney(label, chunk) {
    const m = chunk.match(new RegExp("(?<![A-Za-z])" + label + "\\s*:\\s*\\$?\\s*" + MONEY_RE, "i"));
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }

  function crField(label, chunk) {
    const m = chunk.match(new RegExp("(?<![A-Za-z])" + label + "\\s*:\\s*(.*?)(?=\\s*" + CR_LABELS + "|\\n|$)", "i"));
    return m ? m[1].trim() : "";
  }

  function crKind(name, type, industry) {
    const s = (name + " " + industry).toLowerCase();
    if (CR_STUDENT.some((k) => s.includes(k))) return "student_loan";
    if (CR_AUTO.some((k) => s.includes(k))) return "auto_loan";
    if (/^revolv/i.test(type) || industry.toLowerCase().includes("credit card")) return "credit_card";
    if (s.includes("medical")) return "medical";
    if ((type + " " + industry).toLowerCase().includes("mortgage")) return "mortgage";
    return "other";
  }

  function accountLast4(raw) {
    const digits = (raw || "").match(/\d{2,}/g);
    return digits ? digits[digits.length - 1].slice(-4) : "";
  }

  // The tradeline layout used by Experian-fed screening reports (SafeRent etc.).
  function parseScreeningReport(text) {
    const debts = [];
    const heads = [...text.matchAll(CR_TRADELINE_HEAD)];
    heads.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(text.length, start + 2500);
      let block = text.slice(start, end);
      const term = block.match(CR_SECTION_END);
      if (term) block = block.slice(0, term.index);
      const balance = crMoney("Balance", block);
      if (!balance) return;
      const name = m[1].replace(/\s+/g, " ").replace(/^[- ]+|[- ]+$/g, "");
      debts.push({
        name: name.slice(0, 60), balance, apr: 0,
        min_payment: crMoney("Payment", block) || 0,
        past_due: crMoney("Past Due", block) || 0,
        term_months: null, due_day: 1,
        kind: crKind(name, crField("Type", block), crField("Industry", block)),
        account_last4: accountLast4(crField("Account\\s*#", block)),
      });
    });
    // Collections: anchored on "Balance Due" with a collection marker nearby.
    // The creditor's name renders as the leading text of the rows between the
    // "Creditor:" label and the balance line (the left column of the layout).
    for (const m of text.matchAll(new RegExp("(?<![A-Za-z])Balance Due\\s*:\\s*\\$?\\s*" + MONEY_RE, "gi"))) {
      const win = text.slice(Math.max(0, m.index - 500), m.index);
      const after = text.slice(m.index, m.index + 300);
      if (!/collection/i.test(win + after)) continue;
      const balance = Number(m[1].replace(/,/g, ""));
      if (!balance) continue;
      const creds = [...win.matchAll(/Creditor\s*:/gi)];
      const parts = [];
      if (creds.length) {
        const last = creds[creds.length - 1];
        for (const ln of win.slice(last.index + last[0].length).split(/\r?\n/)) {
          const lead = ln.trim().split(new RegExp(CR_LABELS))[0].trim();
          if (lead) parts.push(lead);
        }
      }
      const name = parts.join(" ").slice(0, 50) || crField("Collection Agency", win) || "Collection account";
      debts.push({
        name: (name + " (collection)").slice(0, 60), balance, apr: 0,
        min_payment: 0, term_months: null, due_day: 1, kind: "other",
        account_last4: accountLast4(crField("Account/Serial\\s*#", win + after)),
      });
    }
    return debts;
  }

  // Consumer bureau reports ("Three Bureau Credit Report", Equifax/Experian/
  // TransUnion side-by-side columns) list accounts as numbered subsections
  // ("4.1 Ed Financial/esa") with one labeled row per field and up to three
  // values per row (one per bureau).
  const TB_SUBHEAD = /^[ \t\f]*\d+\.\d+\s+([A-Za-z][A-Za-z&'./ -]{1,50}?)\s*(\(CLOSED\))?\s*$/gm;
  const TB_KINDS = [["student", "student_loan"], ["auto", "auto_loan"], ["creditcard", "credit_card"],
    ["credit card", "credit_card"], ["mortgage", "mortgage"], ["medical", "medical"]];

  // Largest dollar value on the field's row (bureaus can disagree; be conservative).
  function tbMoneyMax(label, block) {
    const vals = [];
    for (const m of block.matchAll(new RegExp(label + "((?:\\s+(?:\\$[\\d,]+(?:\\.\\d{1,2})?|N/A)){1,3})", "g"))) {
      for (const tok of m[1].trim().split(/\s+/)) {
        if (tok.startsWith("$")) vals.push(Number(tok.slice(1).replace(/,/g, "")));
      }
    }
    return vals.length ? Math.max(...vals) : null;
  }

  function parseBureauReport(text) {
    const debts = [];
    const heads = [...text.matchAll(TB_SUBHEAD)];
    heads.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(text.length, start + 6000);
      const block = text.slice(start, end);
      const balance = tbMoneyMax("Reported Balance", block) || tbMoneyMax("\\bBalance\\b", block);
      if (!balance) return;
      const name = m[1].replace(/\s+/g, " ").trim();
      const lt = block.match(/Loan Type\s+([A-Za-z ]+)/);
      const loanType = lt ? (lt[1].trim().split(/\s+/).find((t) => t.toUpperCase() !== "N/A") || "") : "";
      const term = block.match(/Term Duration\s+(\d+)/);
      const acct = block.match(/Account Number\s+([^\n]+)/);
      const kindHit = TB_KINDS.find(([key]) => loanType.toLowerCase().includes(key));
      const isCollection = loanType.toLowerCase().includes("collection") || Boolean(m[2]);
      const entry = {
        name: name.slice(0, 60) + (isCollection && !name.toLowerCase().includes("collection") ? " (collection)" : ""),
        balance, apr: 0,
        min_payment: tbMoneyMax("Monthly Payment Amount", block) || 0,
        past_due: tbMoneyMax("Amount Past Due", block) || 0,
        term_months: term && Number(term[1]) > 1 ? Number(term[1]) : null,
        due_day: 1, kind: kindHit ? kindHit[1] : "other",
        account_last4: accountLast4(acct ? acct[1] : ""),
      };
      // High Credit on an installment loan is the original amount, and with
      // the payment and term the contract rate falls out of the math.
      if (!isCollection && entry.term_months) {
        const apr = deriveApr(tbMoneyMax("High Credit", block), entry.min_payment, entry.term_months);
        if (apr) {
          entry.apr = apr;
          entry.apr_estimated = true;
          entry.apr_derived = true;
        }
      }
      debts.push(entry);
    });
    return debts;
  }

  // Typical APRs by debt type, used only when the document carries no rate
  // (credit reports never do) AND the rate can't be derived from the loan's
  // own numbers. Flagged apr_estimated so the review step and any later merge
  // know the number is a guess, not data.
  const APR_ESTIMATES = { credit_card: 24.0, auto_loan: 10.0, student_loan: 6.5,
    personal: 12.0, mortgage: 7.0 };

  // Contract APR implied by an amortized loan (solve payment equation for
  // rate). Credit reports don't list rates, but original amount + monthly
  // payment + term pin the rate down exactly. Bisection on the monthly rate.
  function deriveApr(principal, payment, months) {
    if (!principal || !payment || !months || months < 2) return null;
    if (payment * months <= principal * 1.005) return 0;
    let lo = 0, hi = 0.06; // monthly; caps the answer at 72% APR
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const pv = payment * (1 - Math.pow(1 + mid, -months)) / mid;
      if (pv > principal) lo = mid; else hi = mid;
    }
    const apr = Math.round((lo + hi) / 2 * 12 * 100 * 100) / 100;
    return apr > 0 && apr < 70 ? apr : null;
  }

  function normDebtName(name) {
    return (name || "").toLowerCase().replace("(collection)", "").replace(/[^a-z0-9]/g, "");
  }

  // Same real-world debt? Used to consolidate across documents and imports.
  // Signals, strongest first: equal account last-4; overlapping masked account
  // digits plus a corroborating name or balance; long shared name prefix;
  // shared name words plus a near-equal balance.
  function debtsMatch(a, b) {
    const l1 = (a.account_last4 || "").replace(/^0+/, "");
    const l2 = (b.account_last4 || "").replace(/^0+/, "");
    const n1 = normDebtName(a.name), n2 = normDebtName(b.name);
    let prefix = 0;
    while (prefix < n1.length && prefix < n2.length && n1[prefix] === n2[prefix]) prefix++;
    const b1 = Number(a.balance) || 0, b2 = Number(b.balance) || 0;
    const close = b1 > 0 && b2 > 0 && Math.abs(b1 - b2) <= 0.15 * Math.max(b1, b2);
    if (l1 && l2 && (l1.endsWith(l2) || l2.endsWith(l1))) {
      if (l1 === l2 && l1.length >= 3) return true;
      if (prefix >= 4 || close) return true;
    }
    if (prefix >= 8) return true;
    if (close) {
      if (prefix >= 5) return true;
      // word-level overlap survives renames like "UAS/College Ave Studen"
      // vs "College Avenue Stude"
      const w1 = (a.name || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [];
      const w2 = (b.name || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [];
      let hits = 0;
      for (const x of w1) for (const y of w2) if (x === y || x.includes(y) || y.includes(x)) hits++;
      if (hits >= 2) return true;
    }
    return false;
  }

  // Merge entries that describe the same debt (bureaus list them repeatedly).
  function consolidateDebts(debts) {
    const merged = [];
    for (const d of debts) {
      const dup = merged.find((m) => debtsMatch(d, m));
      if (!dup) { merged.push(Object.assign({}, d)); continue; }
      if (!dup.min_payment && d.min_payment) dup.min_payment = d.min_payment;
      if (dup.kind === "other" && d.kind !== "other") dup.kind = d.kind;
      if (!dup.term_months && d.term_months) dup.term_months = d.term_months;
      if (!dup.account_last4 && d.account_last4) dup.account_last4 = d.account_last4;
      if (d.apr && (!dup.apr || (d.apr_derived && !dup.apr_derived))) {
        dup.apr = d.apr;
        dup.apr_estimated = Boolean(d.apr_estimated);
        dup.apr_derived = Boolean(d.apr_derived);
      }
      dup.balance = Math.max(dup.balance, d.balance);
      dup.past_due = Math.max(dup.past_due || 0, d.past_due || 0);
      if (normDebtName(d.name).length > normDebtName(dup.name).length && !d.name.toLowerCase().includes("collection")) {
        dup.name = d.name;
      }
    }
    return merged;
  }

  // Mirrors importers.parse_credit_report_text: screening tradelines or
  // three-bureau consumer reports, consolidated, with typical APRs filled in
  // and flagged apr_estimated (credit reports never carry rates).
  function parseCreditReportText(text) {
    let debts = parseScreeningReport(text);
    if (!debts.length) debts = parseBureauReport(text);
    debts = consolidateDebts(debts);
    for (const d of debts) {
      if (!d.apr && !d.name.toLowerCase().includes("collection") && APR_ESTIMATES[d.kind]) {
        d.apr = APR_ESTIMATES[d.kind];
        d.apr_estimated = true;
      }
    }
    return debts;
  }

  function normalizeMerchant(desc) {
    return desc.toLowerCase().replace(/[#*\d]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  }

  // ---------------------------------------------------------------- pay stubs

  // Net-pay labels in priority order: the first label that yields a dollar
  // amount wins, and the first amount after the label is the current period
  // (the second is usually the YTD column). Mirrors importers.parse_paystub_text.
  const STUB_NET_LABELS = ["net pay", "net check", "net amount", "take home", "total net",
    "net earnings", "net deposit", "amount deposited", "deposit amount",
    "check amount", "direct deposit"];
  const STUB_GROSS_LABELS = ["gross pay", "total gross", "gross earnings", "total earnings"];
  const STUB_DATE_LABELS = ["pay date", "check date", "date paid", "deposit date",
    "payment date", "advice date", "period end", "pay period"];
  const STUB_DATE_RE = "(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4})";
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7,
    sep: 8, oct: 9, nov: 10, dec: 11 };

  function stubAmount(labels, text) {
    // same-line first: "Net Pay $1,719.68 $19,872.48" (current column, not YTD)
    for (const label of labels) {
      for (const m of text.matchAll(new RegExp(label + "\\W{0,20}?" + MONEY_RE, "gi"))) {
        const value = Number(m[1].replace(/,/g, ""));
        if (value > 0) return value;
      }
    }
    // boxed layouts (Rippling etc.) put the value on a later line with other
    // columns interleaved — take the first $-amount within reach of the label
    for (const label of labels) {
      for (const m of text.matchAll(new RegExp(label, "gi"))) {
        const w = text.slice(m.index + m[0].length, m.index + m[0].length + 120)
          .match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
        if (w) {
          const value = Number(w[1].replace(/,/g, ""));
          if (value > 0) return value;
        }
      }
    }
    return null;
  }

  function stubDate(raw) {
    raw = raw.replace(".", "").trim();
    let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return raw;
    m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) {
      const year = m[3].length === 2 ? "20" + m[3] : m[3];
      return `${year}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    m = raw.match(/^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$/);
    if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
      return `${m[3]}-${String(MONTHS[m[1].slice(0, 3).toLowerCase()] + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    return "";
  }

  function parsePaystubText(text) {
    const net = stubAmount(STUB_NET_LABELS, text);
    const gross = stubAmount(STUB_GROSS_LABELS, text);
    const amount = net || gross;
    if (!amount) return null;
    let date = "";
    outer:
    for (const label of STUB_DATE_LABELS) {
      for (const m of text.matchAll(new RegExp(label, "gi"))) {
        const window = text.slice(m.index + m[0].length, m.index + m[0].length + 450);
        const dates = window.match(new RegExp(STUB_DATE_RE, "g")) || [];
        // "pay period: 12/21 - 12/27" -> the period END is the payday side
        const pick = label === "pay period" ? dates[dates.length - 1] : dates[0];
        if (pick) {
          date = stubDate(pick);
          if (date) break outer;
        }
      }
    }
    let source = "";
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/earnings statement|pay ?stub|payroll advice|advice of deposit|statement of/gi, "")
        .replace(/\s+/g, " ").trim();
      if (line.replace(/[^A-Za-z]/g, "").length >= 3) {
        source = line.slice(0, 32);
        break;
      }
    }
    return { amount: r2(amount), net: net !== null, date, source: source || "Paycheck" };
  }

  // ---------------------------------------------------------------- cut plan

  // Known brands, grouped so "DOORDASH*TACOS" and "DOORDASH*WINGS" are one
  // line. action: cancel = subscription you won't miss; eliminate =
  // convenience premium with a cheap substitute (cut 100%); trim = habit to
  // halve. Mirrors importers.CUT_BRANDS.
  const CUT_BRANDS = [
    ["doordash", "DoorDash", "eliminate"], ["uber eats", "Uber Eats", "eliminate"],
    ["uber *eats", "Uber Eats", "eliminate"], ["uber * eats", "Uber Eats", "eliminate"],
    ["ubereats", "Uber Eats", "eliminate"], ["grubhub", "Grubhub", "eliminate"],
    ["instacart", "Instacart", "eliminate"], ["postmates", "Postmates", "eliminate"],
    ["favor ", "Favor delivery", "eliminate"],
    ["netflix", "Netflix", "cancel"], ["hulu", "Hulu", "cancel"],
    ["spotify", "Spotify", "cancel"], ["disney", "Disney+", "cancel"],
    ["hbo", "HBO Max", "cancel"], ["paramount", "Paramount+", "cancel"],
    ["peacock", "Peacock", "cancel"], ["crunchyroll", "Crunchyroll", "cancel"],
    ["youtube", "YouTube Premium", "cancel"], ["audible", "Audible", "cancel"],
    ["patreon", "Patreon", "cancel"], ["onlyfans", "OnlyFans", "cancel"],
    ["openai", "ChatGPT", "cancel"], ["chatgpt", "ChatGPT", "cancel"],
    ["apple.com", "Apple subscriptions/in-app", "eliminate"],
    ["google play", "Google Play in-app purchases", "eliminate"],
    ["google *", "Google Play in-app purchases", "eliminate"],
    ["xsolla", "In-game purchases (Xsolla)", "eliminate"],
    ["playstation", "PlayStation purchases", "eliminate"],
    ["xbox", "Xbox purchases", "eliminate"], ["steam", "Steam purchases", "eliminate"],
    ["starbucks", "Starbucks", "trim"], ["dunkin", "Dunkin", "trim"],
    ["mcdonald", "McDonald's", "trim"], ["chick-fil-a", "Chick-fil-A", "trim"],
    ["taco bell", "Taco Bell", "trim"], ["chipotle", "Chipotle", "trim"],
    ["whataburger", "Whataburger", "trim"], ["wendy", "Wendy's", "trim"],
    ["raising cane", "Raising Cane's", "trim"], ["sonic", "Sonic", "trim"],
  ];

  // Necessity-weighted priority: each move gets a cut fraction (how much of
  // the spending to drop) and a necessity weight (0 = pure luxury, 1 =
  // essential). Ranking uses dollars-freed x (1 - necessity) x a small
  // frequency boost, so a $50 delivery habit outranks a $60 gas
  // "optimization" — essentials are only squeezed after everything easier.
  const CUT_RULES = {
    eliminate: [1.0, 0.05], // pure convenience premium — cut it entirely
    cancel: [1.0, 0.10],     // subscriptions
    trim: [0.5, 0.35],       // habits: go half as often
    tail: [0.3, 0.50],       // category one-offs
    squeeze: [0.1, 0.85],    // essentials: last resort, small shave
    review: [0.0, 0.60],     // unidentified recurring charge: never counted as savings
  };
  const SQUEEZE_CATS = ["Groceries", "Gas & Fuel", "Transport"];

  const CUT_WORDING = {
    cancel: "cancel it — a subscription you're paying every month",
    eliminate: "cut it entirely — pure convenience, the substitute is free or already budgeted",
    trim: "go half as often",
    review: "recurring charge the app can't identify — if it's a bill (insurance, rent), " +
      "press Keep so it's never counted as cuttable; if it's an unwanted subscription, cancel it",
  };

  function cutPriority(cut, necessity, perMonth) {
    const freq = 1 + Math.min(perMonth || 0, 12) / 24; // frequent habits are easier to shave
    return Math.round(cut * (1 - necessity) * freq * 100) / 100;
  }

  function exampleLine(date, desc, amount) {
    const clean = desc.replace(/\s+/g, " ").trim().slice(0, 28);
    return `${date.slice(5)} ${clean} $${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  }

  // Mirrors importers.build_cut_plan — concrete, merchant-level plan for
  // freeing money for debt: names the actual merchants with monthly amounts,
  // frequency and example charges, tiered by pain (cancel subscriptions,
  // eliminate delivery/in-app spending, halve habits, trim the tail).
  function buildCutPlan(transactions, months, protectedLabels) {
    months = months || 6;
    const protect = new Set((protectedLabels || []).map((p) => p.toLowerCase()));
    const monthSet = new Set();
    const groups = {};
    const catSpend = {};
    const squeeze = {}; // essential category -> { total, merchants: { label: $ } }
    for (const t of transactions) {
      if (t.amount >= 0 || !DISCRETIONARY.has(t.category)) {
        if (t.amount < 0 && !["Transfers", "Debt Payment"].includes(t.category)) {
          monthSet.add(t.date.slice(0, 7));
          if (SQUEEZE_CATS.includes(t.category)) {
            const s = squeeze[t.category] = squeeze[t.category] || { total: 0, merchants: {} };
            const label = t.description.replace(/\s+/g, " ").trim().slice(0, 28);
            s.total -= t.amount;
            s.merchants[label] = (s.merchants[label] || 0) - t.amount;
          }
        }
        continue;
      }
      const month = t.date.slice(0, 7);
      monthSet.add(month);
      const low = t.description.toLowerCase();
      const brand = CUT_BRANDS.find(([kw]) => low.includes(kw)) || null;
      const key = brand ? brand[1] : normalizeMerchant(t.description);
      const g = groups[key] = groups[key] || {
        label: brand ? brand[1] : t.description.replace(/\s+/g, " ").trim().slice(0, 32),
        action: brand ? brand[2] : null,
        category: t.category, hits: [],
      };
      g.hits.push([month, -t.amount, t.description, t.date]);
      catSpend[t.category] = (catSpend[t.category] || 0) - t.amount;
    }

    // drop protected merchants entirely (and their spend from category tails)
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      if (protect.has(g.label.toLowerCase())) {
        catSpend[g.category] = (catSpend[g.category] || 0) - g.hits.reduce((s, h) => s + h[1], 0);
        delete groups[key];
      }
    }

    const monthKeys = [...monthSet].sort().slice(-months);
    const nMonths = Math.max(1, monthKeys.length);
    const items = [];
    for (const g of Object.values(groups)) {
      const hits = g.hits.filter((h) => monthKeys.includes(h[0]));
      const kept = hits.length ? hits : g.hits;
      const total = kept.reduce((s, h) => s + h[1], 0);
      const avg = total / nMonths;
      if (avg < 10) continue;
      const perMonth = kept.length / nMonths;
      const monthsSeen = new Set(kept.map((h) => h[0])).size;
      const amounts = kept.map((h) => h[1]);
      let action = g.action;
      if (!action) {
        const steady = monthsSeen >= 2 && perMonth <= 1.5 &&
          Math.max(...amounts) - Math.min(...amounts) <= Math.max(2.0, (total / kept.length) * 0.25);
        // a steady monthly charge is only "cancel a subscription" advice when
        // it lives in a subscription-ish category — a same-priced monthly
        // Target run is a habit, not a membership
        if (steady && g.category === "Subscriptions") {
          action = "cancel";
        } else if (steady) {
          action = "review"; // could be insurance or rent — ask, don't advise
        } else if ((perMonth >= 4 || avg >= 40) && (monthsSeen >= 2 || kept.length >= 3)) {
          // a repeated habit — a single large one-off (new tires, a repair)
          // is NOT a habit to halve; it rolls into the tail
          action = "trim";
        } else {
          continue;
        }
      }
      const [fraction, necessity] = CUT_RULES[action];
      const cut = avg * fraction;
      const biggest = kept.slice().sort((a, b) => b[1] - a[1]).slice(0, 3);
      const freqTxt = perMonth >= 0.75
        ? `${Math.max(1, Math.round(perMonth))} charge(s)/mo`
        : `${kept.length} charge(s) in ${nMonths} month(s)`;
      items.push({
        action, label: g.label, category: g.category,
        monthly_avg: r2(avg), suggested_cut: r2(cut),
        necessity,
        priority: cutPriority(cut, necessity, perMonth),
        per_month: Math.round(perMonth * 10) / 10,
        months_seen: monthsSeen,
        message: `$${Math.round(avg).toLocaleString("en-US")}/mo, ${freqTxt} — ` + CUT_WORDING[action],
        examples: biggest.map((h) => exampleLine(h[3], h[2], h[1])),
      });
    }

    // what's left of each category after the named merchants above
    for (const [cat, total] of Object.entries(catSpend)) {
      const named = items.filter((i) => i.category === cat).reduce((s, i) => s + i.monthly_avg, 0);
      const rest = total / nMonths - named;
      if (rest >= 30) {
        const [fraction, necessity] = CUT_RULES.tail;
        const tail = Object.values(groups)
          .filter((g) => g.category === cat && !items.some((i) => i.label === g.label))
          .sort((a, b) => b.hits.reduce((s, h) => s + h[1], 0) - a.hits.reduce((s, h) => s + h[1], 0))
          .slice(0, 3);
        items.push({
          action: "trim",
          label: cat === "Other" ? "Misc one-offs" : `Other ${cat}`,
          category: cat,
          monthly_avg: r2(rest), suggested_cut: r2(rest * fraction),
          necessity,
          priority: cutPriority(rest * fraction, necessity, null),
          per_month: null, months_seen: nMonths,
          message: `$${Math.round(rest).toLocaleString("en-US")}/mo of one-offs — aim 30% lower`,
          examples: tail.map((g) =>
            `${g.label} $${Math.round(g.hits.reduce((s, h) => s + h[1], 0) / nMonths)}/mo`),
        });
      }
    }

    // essentials last: real money, but you need to eat and get to work, so
    // only a small shave and always ranked after every discretionary cut
    for (const [cat, s] of Object.entries(squeeze)) {
      if (protect.has(cat.toLowerCase())) continue;
      const avg = s.total / nMonths;
      const [fraction, necessity] = CUT_RULES.squeeze;
      const cut = avg * fraction;
      if (cut < 12) continue;
      const top = Object.entries(s.merchants).sort((a, b) => b[1] - a[1]).slice(0, 3);
      items.push({
        action: "squeeze", label: cat, category: cat,
        monthly_avg: r2(avg), suggested_cut: r2(cut),
        necessity,
        priority: cutPriority(cut, necessity, null),
        per_month: null, months_seen: nMonths,
        message: `$${Math.round(avg).toLocaleString("en-US")}/mo — essential, so it's last in line; ` +
          "cheaper brands or fewer trips could shave ~10%",
        examples: top.map(([label, amt]) => `${label} $${Math.round(amt / nMonths)}/mo`),
      });
    }

    const kept2 = items.filter((i) => !protect.has(i.label.toLowerCase()));
    kept2.sort((a, b) => b.priority - a.priority);
    return kept2.slice(0, 10);
  }

  function spendingSummary(transactions, months, protectedLabels) {
    months = months || 6;
    const byMonth = {};
    const incomeByMonth = {};
    const merchants = {};
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      if (t.amount >= 0 || ["Transfers", "Debt Payment", "Income"].includes(t.category)) {
        if (t.amount > 0 && t.category === "Income") {
          incomeByMonth[month] = (incomeByMonth[month] || 0) + t.amount;
        }
        continue;
      }
      const spent = -t.amount;
      const cat = t.category || "Other";
      (byMonth[month] = byMonth[month] || {})[cat] = (byMonth[month][cat] || 0) + spent;
      const key = normalizeMerchant(t.description);
      (merchants[key] = merchants[key] || []).push([month, spent, t.description, cat]);
    }

    const monthKeys = Object.keys(byMonth).sort().slice(-months);
    const byMonthKept = {};
    for (const m of monthKeys) {
      byMonthKept[m] = {};
      for (const [k, v] of Object.entries(byMonth[m])) byMonthKept[m][k] = r2(v);
    }
    const nMonths = Math.max(1, monthKeys.length);

    const catTotals = {};
    for (const m of monthKeys) {
      for (const [cat, amt] of Object.entries(byMonth[m])) {
        catTotals[cat] = (catTotals[cat] || 0) + amt;
      }
    }
    const categories = Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([category, total]) => ({
        category,
        total: r2(total),
        monthly_avg: r2(total / nMonths),
        discretionary: DISCRETIONARY.has(category),
      }));

    const recurring = [];
    for (const hits of Object.values(merchants)) {
      if (ESSENTIAL_RECURRING.has(hits[0][3])) continue;
      const hitMonths = new Set(hits.map((h) => h[0]));
      if (hitMonths.size >= 2) {
        const amounts = hits.map((h) => h[1]);
        const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const spread = Math.max(...amounts) - Math.min(...amounts);
        if (avg > 0 && spread <= Math.max(2.0, avg * 0.25)) {
          recurring.push({ merchant: hits[0][2].slice(0, 48), monthly_avg: r2(avg),
            months_seen: hitMonths.size });
        }
      }
    }
    recurring.sort((a, b) => b.monthly_avg - a.monthly_avg);

    const suggestions = buildCutPlan(transactions, months, protectedLabels);

    const incomeKept = {};
    for (const m of Object.keys(incomeByMonth).sort().slice(-months)) {
      incomeKept[m] = r2(incomeByMonth[m]);
    }
    return {
      months: monthKeys,
      by_month: byMonthKept,
      categories,
      income_by_month: incomeKept,
      recurring: recurring.slice(0, 20),
      suggestions,
      total_monthly_spend: r2(categories.reduce((s, c) => s + c.monthly_avg, 0)),
      potential_monthly_savings: r2(suggestions.reduce((s, x) => s + x.suggested_cut, 0)),
    };
  }

  // ================================================================ routes
  // Mirrors app/server.py so the frontend works unchanged.

  function listDebts(db) {
    return db.debts.slice().sort((a, b) => b.apr - a.apr || b.balance - a.balance);
  }

  function listBills(db) {
    return db.bills.slice().sort((a, b) => a.due_day - b.due_day || a.name.localeCompare(b.name));
  }

  function listPaychecks(db, limit) {
    return db.paychecks.slice().sort((a, b) =>
      b.date.localeCompare(a.date) || b.id - a.id).slice(0, limit || 50);
  }

  function listTransactions(db, limit) {
    return db.transactions.slice().sort((a, b) =>
      b.date.localeCompare(a.date) || b.id - a.id).slice(0, limit || 1000);
  }

  function upsertDebt(db, d) {
    const fields = {
      name: (d.name || "Debt").trim(),
      kind: d.kind || "other",
      balance: Number(d.balance) || 0,
      apr: Number(d.apr) || 0,
      min_payment: Number(d.min_payment) || 0,
      term_months: d.term_months ? Math.trunc(Number(d.term_months)) : null,
      due_day: Math.max(1, Math.min(28, Math.trunc(Number(d.due_day)) || 1)),
      notes: d.notes || "",
      account_last4: d.account_last4 || "",
      apr_estimated: d.apr_estimated ? 1 : 0,
      past_due: Math.max(0, Number(d.past_due) || 0),
    };
    if (d.id) {
      const existing = db.debts.find((x) => x.id === Number(d.id));
      if (existing) Object.assign(existing, fields);
    } else {
      db.debts.push(Object.assign({ id: nextId(db) }, fields));
    }
  }

  function upsertBill(db, b) {
    const fields = {
      name: (b.name || "Bill").trim(),
      category: b.category || "Other",
      amount: Number(b.amount) || 0,
      due_day: Math.max(1, Math.min(28, Math.trunc(Number(b.due_day)) || 1)),
      notes: b.notes || "",
    };
    if (b.id) {
      const existing = db.bills.find((x) => x.id === Number(b.id));
      if (existing) Object.assign(existing, fields);
    } else {
      db.bills.push(Object.assign({ id: nextId(db), reserved: 0 }, fields));
    }
  }

  function buildAndApplyPlan(db, amount, payDate, source, apply) {
    const settings = getSettings(db);
    const bills = listBills(db);
    const debts = listDebts(db);
    const plan = buildPlan(amount, payDate, bills, debts, settings, db.goals || []);

    const extraMonthly = plan.totals.debt_extra * CHECKS_PER_MONTH[settings.pay_frequency];
    if (debts.length && extraMonthly > 0) {
      const base = simulatePayoff(debts, settings.strategy, 0);
      const boosted = simulatePayoff(debts, settings.strategy, extraMonthly);
      if (base.months && boosted.months) {
        plan.impact = {
          months_saved: base.months - boosted.months,
          interest_saved: r2(base.total_interest - boosted.total_interest),
          debt_free_date: boosted.debt_free_date,
        };
      }
    }

    if (apply) {
      for (const [billId, reserved] of Object.entries(plan.reserve_updates)) {
        const bill = db.bills.find((x) => x.id === Number(billId));
        if (bill) bill.reserved = reserved;
      }
      for (const [goalId, saved] of Object.entries(plan.goal_updates || {})) {
        const goal = (db.goals || []).find((x) => x.id === Number(goalId));
        if (goal) goal.saved = saved;
      }
      for (const item of plan.items) {
        if (["debt_min", "debt_extra", "catchup"].includes(item.kind) && item.debt_id) {
          const debt = db.debts.find((x) => x.id === item.debt_id);
          if (debt) {
            debt.balance = r2(Math.max(0, debt.balance - item.amount));
            if (item.kind === "catchup") {
              debt.past_due = r2(Math.max(0, (Number(debt.past_due) || 0) - item.amount));
            }
          }
        }
      }
      if (plan.totals.emergency > 0) {
        db.settings.emergency_balance =
          String(r2(Number(getSettings(db).emergency_balance) + plan.totals.emergency));
      }
      const id = nextId(db);
      db.paychecks.push({ id, source, amount: plan.amount, date: plan.pay_date, plan });
      plan.paycheck_id = id;
      save(db);
    }
    return plan;
  }

  function addTransactions(db, txns) {
    let added = 0;
    for (const t of txns) {
      const dup = db.transactions.some((x) =>
        x.date === t.date && x.description === t.description && x.amount === t.amount);
      if (dup) continue;
      db.transactions.push({ id: nextId(db), date: t.date, description: t.description,
        amount: t.amount, category: t.category || "" });
      added++;
    }
    return added;
  }

  function stateResponse(db) {
    const settings = getSettings(db);
    const debts = listDebts(db);
    const bills = listBills(db);
    const paychecks = listPaychecks(db, 12);
    return {
      settings, debts, bills, paychecks,
      budget: estimateMonthlyExtra(bills, debts, settings, paychecks, listTransactions(db, 10000)),
      goals: (db.goals || []).slice().sort((a, b) => a.due_date.localeCompare(b.due_date)),
      today: todayISO(),
    };
  }

  function protectedList(settings) {
    try { return JSON.parse(settings.protected || "[]"); } catch (e) { return []; }
  }

  // Re-apply current rules (built-in, user, and debt-derived) to every
  // transaction the user hasn't hand-categorized. Runs before anything is
  // computed, so categorization improvements and newly imported debts correct
  // existing data automatically — the user never has to re-import or press
  // anything.
  function autoRecategorize(db) {
    const rules = mergeRules(db.rules, listDebts(db));
    let changed = 0;
    for (const t of db.transactions) {
      if (t.locked) continue;
      let cat = categorize(t.description, rules);
      if (t.amount > 0 && cat === "Other") cat = t.category; // keep deposit guesses
      if (cat !== t.category) { t.category = cat; changed++; }
    }
    if (changed) save(db);
    return changed;
  }

  function handle(path, body) {
    const [route, queryStr] = path.split("?");
    const query = {};
    for (const pair of (queryStr || "").split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=");
      query[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    const db = load();
    const settings = getSettings(db);

    switch (route) {
      case "/api/state":
        autoRecategorize(db);
        return stateResponse(db);

      case "/api/projection": {
        autoRecategorize(db);
        const debts = listDebts(db);
        const txns = listTransactions(db, 10000);
        const budget = estimateMonthlyExtra(listBills(db), debts, settings, listPaychecks(db), txns);
        let extra = budget.monthly_extra;
        if (query.extra !== undefined && query.extra !== "" && !isNaN(Number(query.extra))) {
          extra = Number(query.extra);
        }
        // Where to find more money: cuttable spending from imported
        // statements, and what sending it to debt would change.
        let advice = null;
        if (txns.length && debts.some((d) => d.balance > 0.01)) {
          const summary = spendingSummary(txns, 6, protectedList(settings));
          if (summary.suggestions.length) {
            const target = pickTargetDebt(debts, settings.strategy);
            const cut = summary.potential_monthly_savings;
            const boosted = simulatePayoff(debts, settings.strategy, extra + cut);
            advice = {
              suggestions: summary.suggestions,
              monthly_freed: cut,
              target_debt: target ? target.name : null,
              boosted: {
                months: boosted.months,
                debt_free_date: boosted.debt_free_date,
                total_interest: boosted.total_interest,
                stuck: boosted.stuck,
              },
            };
          }
        }
        return { budget, comparison: compareStrategies(debts, extra), extra_used: extra, advice };
      }

      case "/api/transactions":
        return { transactions: listTransactions(db) };

      case "/api/spending": {
        autoRecategorize(db);
        const txns = listTransactions(db, 10000);
        const summary = spendingSummary(txns, Number(query.months) || 6, protectedList(settings));
        const debts = listDebts(db);
        const budget = estimateMonthlyExtra(listBills(db), debts, settings, listPaychecks(db), txns);
        const cut = summary.potential_monthly_savings;
        if (cut > 0 && debts.some((d) => d.balance > 0.01)) {
          const base = simulatePayoff(debts, settings.strategy, budget.monthly_extra);
          const boosted = simulatePayoff(debts, settings.strategy, budget.monthly_extra + cut);
          if (base.months && boosted.months) {
            summary.cut_impact = {
              months_saved: base.months - boosted.months,
              interest_saved: r2(base.total_interest - boosted.total_interest),
            };
          }
        }
        return summary;
      }

      case "/api/rules":
        if (body) {
          db.rules.push({ id: nextId(db), keyword: body.keyword.toLowerCase(), category: body.category });
          save(db);
        }
        return { ok: true, rules: db.rules.slice().sort((a, b) => a.keyword.localeCompare(b.keyword)) };

      case "/api/rules/delete":
        db.rules = db.rules.filter((r) => r.id !== Number(body.id));
        save(db);
        return { ok: true };

      case "/api/export":
        return {
          settings, debts: listDebts(db), bills: listBills(db),
          paychecks: listPaychecks(db, 100000),
          transactions: listTransactions(db, 100000),
          rules: db.rules,
        };

      case "/api/debts":
        for (const d of Array.isArray(body) ? body : [body]) upsertDebt(db, d);
        save(db);
        return { ok: true, debts: listDebts(db) };

      case "/api/debts/delete":
        db.debts = db.debts.filter((d) => d.id !== Number(body.id));
        save(db);
        return { ok: true };

      case "/api/debts/import": {
        const text = body.text || "";
        let debts = parseDebtsCsv(text);
        let source = "csv";
        if (!debts.length) { debts = parseCreditReportText(text); source = "report"; }
        if (!debts.length) { debts = parseDebtsText(text); source = "text"; }
        // flag debts we already track so the import updates them instead of
        // creating duplicates
        const existing = listDebts(db);
        for (const d of debts) {
          const m = existing.find((e) => debtsMatch(d, e));
          if (m) { d.match_id = m.id; d.match_name = m.name; }
        }
        return { debts, source };
      }

      case "/api/bills":
        for (const b of Array.isArray(body) ? body : [body]) upsertBill(db, b);
        save(db);
        return { ok: true, bills: listBills(db) };

      case "/api/goals": {
        db.goals = db.goals || [];
        const fields = {
          name: (body.name || "Goal").trim(),
          amount: Math.max(0, Number(body.amount) || 0),
          saved: Math.max(0, Number(body.saved) || 0),
          due_date: String(body.due_date || "").slice(0, 10),
          notes: body.notes || "",
        };
        if (body.id) {
          const g = db.goals.find((x) => x.id === Number(body.id));
          if (g) Object.assign(g, fields);
        } else {
          db.goals.push(Object.assign({ id: nextId(db) }, fields));
        }
        save(db);
        return { ok: true, goals: db.goals };
      }

      case "/api/goals/delete":
        db.goals = (db.goals || []).filter((g) => g.id !== Number(body.id));
        save(db);
        return { ok: true };

      case "/api/bills/delete":
        db.bills = db.bills.filter((b) => b.id !== Number(body.id));
        save(db);
        return { ok: true };

      case "/api/paycheck": {
        const amount = Number(body.amount);
        if (!amount || isNaN(amount)) throw new Error("Bad request: amount");
        const payDate = (body.date || todayISO()).slice(0, 10);
        return { plan: buildAndApplyPlan(db, amount, payDate, body.source || "Paycheck", !body.preview) };
      }

      case "/api/paycheck/parse": {
        const stub = parsePaystubText((body && body.text) || "");
        return { found: Boolean(stub), stub };
      }

      case "/api/paycheck/history": {
        // bulk history import (from pay stub uploads): records income for
        // pattern learning WITHOUT running allocation plans or touching balances
        const existing = new Set(db.paychecks.map((p) => p.date + "|" + r2(p.amount)));
        let added = 0;
        const items = (body && body.items) || [];
        for (const item of items) {
          const amount = r2(Number(item.amount) || 0);
          const date = String(item.date || "").slice(0, 10);
          const key = date + "|" + amount;
          if (amount <= 0 || date.length !== 10 || existing.has(key)) continue;
          db.paychecks.push({ id: nextId(db), source: String(item.source || "Paycheck").slice(0, 40),
            amount, date, plan: null });
          existing.add(key);
          added++;
        }
        save(db);
        return { added, duplicates: items.length - added,
          pattern: paycheckPattern(listPaychecks(db, 100000)) };
      }

      case "/api/paycheck/delete":
        db.paychecks = db.paychecks.filter((p) => p.id !== Number(body.id));
        save(db);
        return { ok: true };

      case "/api/transactions/import": {
        const debts = listDebts(db);
        const rules = mergeRules(db.rules, debts);
        const [txns, note] = body.statement
          ? parseStatementText(body.statement, rules)
          : parseBankCsv(body.csv || "", rules);
        const added = addTransactions(db, txns);
        // the statement reveals when debt payments actually post — use that
        // to fill in due days still sitting at the default
        const inferred = inferDebtDueDays(debts, listTransactions(db, 10000));
        const dueNotes = [];
        for (const d of debts) {
          const day = inferred[d.id];
          if (day && day !== 1 && d.due_day === 1) {
            upsertDebt(db, Object.assign({}, d, { due_day: day }));
            dueNotes.push(`${d.name}: due day set to day ${day} of the month (from your payment history)`);
          }
        }
        save(db);
        return { parsed: txns.length, added, duplicates: txns.length - added, note,
          due_day_updates: dueNotes };
      }

      case "/api/transactions/recategorize":
        return { changed: autoRecategorize(db) };

      case "/api/transactions/clear":
        db.transactions = [];
        save(db);
        return { ok: true };

      case "/api/transactions/category": {
        const t = db.transactions.find((x) => x.id === Number(body.id));
        // a category the user chose by hand is locked: auto-recategorization
        // must never overwrite their judgement
        if (t) { t.category = body.category; t.locked = 1; }
        save(db);
        return { ok: true };
      }

      case "/api/settings": {
        for (const [key, value] of Object.entries(body || {})) {
          if (key in DEFAULT_SETTINGS) db.settings[key] = String(value);
        }
        save(db);
        return { ok: true, settings: getSettings(db) };
      }

      case "/api/quit":
        return { ok: true, bye: true };

      default:
        throw new Error("not found: " + route);
    }
  }

  window.LOCAL_API = {
    call(path, body) {
      // Async to match fetch-based api(); serialize to strip prototypes,
      // exactly like a JSON round-trip through the server would.
      return Promise.resolve().then(() => JSON.parse(JSON.stringify(handle(path, body))));
    },
    // exposed for tests
    _internals: { buildPlan, simulatePayoff, spendingSummary, parseBankCsv, parseDebtsCsv,
      parseDebtsText, parseCreditReportText, parseStatementText, nextDueDate, estimateMonthlyExtra,
      debtsMatch, consolidateDebts },
  };
})();
