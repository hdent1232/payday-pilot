"""End-to-end smoke test: boots the real server against a temp database and
walks through the whole workflow — debts, bills, settings, a paycheck plan,
bank statement import, spending analysis and payoff projections.

Run from the paydaypilot directory:  python -m tests.test_smoke
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.request

TMP = tempfile.mkdtemp(prefix="paydaypilot-test-")
os.environ["PAYDAYPILOT_DATA"] = TMP

from app.server import serve  # noqa: E402  (env var must be set first)

BANK_CSV = """Date,Description,Amount
2026-05-01,PAYROLL DIRECT DEP,1850.00
2026-05-02,RENT PAYMENT APARTMENTS LLC,-1200.00
2026-05-03,KROGER #123,-142.55
2026-05-04,NETFLIX.COM,-15.49
2026-05-05,STARBUCKS #4411,-7.85
2026-05-08,SHELL OIL 5551,-48.20
2026-05-12,DOORDASH*BURRITO,-32.40
2026-05-15,PAYROLL DIRECT DEP,1850.00
2026-05-18,AMAZON MKTPLACE,-89.99,
2026-06-02,RENT PAYMENT APARTMENTS LLC,-1200.00
2026-06-03,KROGER #123,-131.02
2026-06-04,NETFLIX.COM,-15.49
2026-06-06,STARBUCKS #4411,-9.10
2026-06-10,DOORDASH*PIZZA,-41.15
"""

DEBTS_CSV = """name,balance,apr,min payment,term,due day
Capital One Visa,2450.00,26.99,75,,15
Toyota auto loan,14800,6.4,385,48,5
"""

CREDIT_REPORT_TEXT = """
CHASE FREEDOM VISA
Balance: $3,204.55
APR: 24.99%
Minimum payment: $96

Discover it Card   Balance $890.10   18.5% APR   min payment $35
"""

# Mimics the tradeline layout of Experian-fed screening reports (SafeRent
# etc.) after pdf.js flattens the two-column PDF into lines. Fake data.
SCREENING_REPORT_TEXT = """SAFERENT SCORE REPORT powered by VantageScore 4.0
Credit Details - Information provided by Experian
Credit Summary
Total Tradelines 4 Collections 1 Public Records 0

Collections
Creditor: Date Reported: 11/01/2025 Collection Agency: EXAMPLE RECOVERY CO
CITY UTILITY DISTRICT Agency Customer #: 1234567 Original Amount Owed: $842
Balance Due: $842 Balance Date: 05/01/2026
Past Due Amount: $842 Account/Serial #: XXX9999

Tradelines
FIRST EXAMPLE LENDING - Member # 1111111 Status: Account 30 days past due date
Reported: 04/01/2026 Type: Installment High Credit: N/A Credit Limit: N/A
Opened: 08/24/2023 Industry: Service & Professional Payment: $210 Past Due: $420
Last Activity: 04/30/2026 Account #: XXXX1234 Balance: $12,450 Months Reviewed: 30
Original Loan Amount: $15,000 ECOA: Individual Narrative: N/A

Payment Summary (30 Months) Dec Nov Oct Sep Aug Jul Jun May Apr Mar Feb Jan
C = Current 2026 30 C C C

EXAMPLE BANK CARD - Member # 2222222 Status: This is an account in good standing
Reported: 05/01/2026 Type: Revolving High Credit: $900 Credit Limit: $800
Opened: 08/26/2024 Industry: Bank Credit Card Payment: $25 Past Due: N/A
Last Activity: 05/11/2026 Account #: N/A Balance: $310 Months Reviewed: 20

PAIDOFF CARD CO - Member # 3333333 Status: This is an account in good standing
Reported: 05/01/2026 Type: Revolving High Credit: $500 Credit Limit: $500
Payment: $0 Past Due: N/A Balance: $0 Months Reviewed: 12

CAMPUS STUDENT LNS - Member # 4444444 Status: Account delinquent 180 days past due date
Reported: 05/01/2026 Type: Installment Payment: $66 Past Due: $462
Account #: XXX0829 Balance: $6,280 Months Reviewed: 34
Original Loan Amount: $5,500 ECOA: Individual

Inquiries
Date Account Name Account Number
12/24/2024 EXAMPLE INQUIRY 1234567
"""


# Mimics a "Three Bureau Credit Report" (Equifax/Experian/TransUnion columns,
# numbered account subsections). Fake data. The collection is listed twice —
# under installments (closed, sold) and under other accounts — like real
# reports do; the importer must consolidate it.
TB_REPORT_TEXT = """Jun 06, 2026 Three Bureau Credit Report powered by Equifax
2. Revolving Accounts

2.1 Example Bank Card
 Reported                              Yes                     Yes                            Yes
 Account Number                        xxxxxxxx 5010           xxxxxxxx 5010                  xxxxxxxx 5010
 Reported Balance                      $450                    $450                           $450
Account Details
 Account Type                          Revolving               Revolving                      Revolving
 Loan Type                             creditcard              creditcard                     creditcard
 Term Duration                         0                       0                              0
 Credit Limit                          $800                    $800                           $800
 Monthly Payment Amount                $25                     $25                            $25

4. Installment Accounts

4.1 Example Auto Finance
 Account Number                        xxxxxx 77               xxxxxx 77                      xxxxxx 77
 Reported Balance                      $8,000                  $8,100                         $8,000
 Loan Type                             automobile              automobile                     automobile
 Term Duration                         48                      48                             48
 High Credit                           $10,000                 $10,000                        $10,000
 Monthly Payment Amount                $310                    $310                           $310

4.2 Example Collections Co (CLOSED)
 Account Number                        xxxxx 55                N/A                            xxxxx 55
 Reported Balance                      $900                    N/A                            $900
 Loan Type                             collectionattorney      N/A                            N/A
 Term Duration                         1                       N/A                            N/A
 Monthly Payment Amount                $0                      N/A                            N/A

5. Other Accounts

5.1 Example Collections Co
 Account Number                        xxxxx 55                N/A                            xxxxx 55
 Reported Balance                      $900                    N/A                            $900
"""


class SmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = serve(0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, path, body=None, expect=200):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path, data=data,
            headers={"Content-Type": "application/json"} if data else {},
        )
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, expect)
            return json.loads(res.read().decode())

    def test_full_workflow(self):
        # -- static UI is served
        with urllib.request.urlopen(self.base + "/") as res:
            self.assertIn("PayDay Pilot", res.read().decode())

        # -- settings
        self.call("/api/settings", {
            "pay_frequency": "biweekly", "strategy": "avalanche",
            "variable_budget": 500, "emergency_target": 1000,
            "emergency_balance": 200, "emergency_pct": 20, "fun_pct": 5,
        })

        # -- bills
        for bill in [
            {"name": "Rent", "category": "Housing", "amount": 1200, "due_day": 1},
            {"name": "Electric", "category": "Utilities", "amount": 90, "due_day": 12},
            {"name": "Wifi", "category": "Utilities", "amount": 65, "due_day": 20},
            {"name": "Car insurance", "category": "Insurance", "amount": 140, "due_day": 25},
        ]:
            self.call("/api/bills", bill)

        # -- debts via CSV import then confirm
        parsed = self.call("/api/debts/import", {"text": DEBTS_CSV})
        self.assertEqual(parsed["source"], "csv")
        self.assertEqual(len(parsed["debts"]), 2)
        self.call("/api/debts", parsed["debts"])

        # -- debts via pasted credit-report text
        scanned = self.call("/api/debts/import", {"text": CREDIT_REPORT_TEXT})
        self.assertEqual(scanned["source"], "text")
        self.assertGreaterEqual(len(scanned["debts"]), 2)
        balances = sorted(d["balance"] for d in scanned["debts"])
        self.assertIn(3204.55, balances)
        self.assertIn(890.10, balances)

        # -- debts via a full credit-report PDF's extracted text (review only,
        #    nothing saved until confirmed)
        report = self.call("/api/debts/import", {"text": SCREENING_REPORT_TEXT})
        self.assertEqual(report["source"], "report")
        self.assertEqual(len(report["debts"]), 4)

        state = self.call("/api/state")
        self.assertEqual(len(state["bills"]), 4)
        self.assertEqual(len(state["debts"]), 2)

        # -- paycheck preview does not persist
        preview = self.call("/api/paycheck", {
            "amount": 1850, "date": "2026-07-01", "source": "Job", "preview": True,
        })["plan"]
        self.assertEqual(preview["amount"], 1850)
        self.assertAlmostEqual(preview["totals"]["allocated"], 1850, places=2)
        self.assertEqual(len(self.call("/api/state")["paychecks"]), 0)

        # -- real paycheck: allocations add up and state mutates
        # (2600 is enough to cover rent + obligations and reach the
        # emergency/extra-debt tiers of the allocator)
        plan = self.call("/api/paycheck", {
            "amount": 2600, "date": "2026-07-01", "source": "Job",
        })["plan"]
        self.assertAlmostEqual(plan["totals"]["allocated"], 2600, places=2)
        self.assertGreater(plan["totals"]["emergency"], 0)
        self.assertGreater(plan["totals"]["debt_extra"], 0)
        self.assertEqual(plan["target_debt"], "Capital One Visa")  # highest APR
        kinds = {i["kind"] for i in plan["items"]}
        self.assertIn("essentials", kinds)
        self.assertTrue({"bill", "reserve"} & kinds)
        state = self.call("/api/state")
        self.assertEqual(len(state["paychecks"]), 1)
        # emergency contribution applied
        self.assertGreater(float(state["settings"]["emergency_balance"]), 200)
        # debt balances reduced by payments in the plan
        paid = sum(i["amount"] for i in plan["items"] if i["kind"] in ("debt_min", "debt_extra"))
        total_debt = sum(d["balance"] for d in state["debts"])
        self.assertAlmostEqual(total_debt, 2450 + 14800 - paid, places=1)

        # -- projection compares strategies
        proj = self.call("/api/projection?extra=400")
        for key in ("minimum_only", "snowball", "avalanche"):
            self.assertIn(key, proj["comparison"])
        av, mo = proj["comparison"]["avalanche"], proj["comparison"]["minimum_only"]
        self.assertLess(av["months"], mo["months"])
        self.assertLess(av["total_interest"], mo["total_interest"])

        # -- bank statement import + dedupe
        imp = self.call("/api/transactions/import", {"csv": BANK_CSV})
        self.assertGreaterEqual(imp["added"], 13)
        again = self.call("/api/transactions/import", {"csv": BANK_CSV})
        self.assertEqual(again["added"], 0)

        # -- spending analysis
        spend = self.call("/api/spending?months=6")
        cats = {c["category"] for c in spend["categories"]}
        self.assertIn("Housing", cats)
        self.assertIn("Groceries", cats)
        self.assertIn("Dining", cats)
        self.assertTrue(any(r["monthly_avg"] > 0 for r in spend["recurring"]))
        self.assertTrue(spend["suggestions"])  # dining etc. should trigger cut suggestions
        self.assertIn("2026-05", spend["income_by_month"])

        # -- projection now carries cut-and-reallocate advice from spending
        proj = self.call("/api/projection")
        advice = proj["advice"]
        self.assertTrue(advice and advice["suggestions"])
        self.assertGreater(advice["monthly_freed"], 0)
        self.assertTrue(advice["target_debt"])
        self.assertIn("months", advice["boosted"])

        # -- export contains everything
        export = self.call("/api/export")
        for key in ("settings", "debts", "bills", "paychecks", "transactions", "rules"):
            self.assertIn(key, export)

        # -- importing a report again matches the debts we already track
        #    (consolidation instead of duplicates)
        self.call("/api/debts", report["debts"])
        again = self.call("/api/debts/import", {"text": SCREENING_REPORT_TEXT})
        self.assertEqual(report["source"], "report")
        self.assertTrue(all(d.get("match_id") for d in again["debts"]),
                        [d["name"] for d in again["debts"] if not d.get("match_id")])


STATEMENT_TEXT = """
INVESTMENT REPORT
February 1, 2026 - February 28, 2026
Account Summary
Deposits
Date Reference Description Amount
02/06 Deposit Acme Co Payroll $651.17
02/20 Deposit Acme Co Payroll 940.29
Total Deposits $1,591.46
Withdrawals
Date Reference Description Amount
02/02 DEBIT LOAN EPAYMENT -$700.00
02/17 DEBIT GYM CLUB FEES -38.96
Total Withdrawals -$738.96
Core Fund Activity
Settlement Account
Date Type Transaction Description Quantity Price Amount Balance
02/02 CASH You Sold GOVERNMENT MONEY MARKET -700.000 1.0000 -700.00 292.41
02/06 CASH You Bought GOVERNMENT MONEY MARKET 651.170 1.0000 651.17 696.23
Debit Card Summary Debit Card Activity
TRANSACTIONS
Trans. Date Post Date Location Reference/Description Amount
Purchases
01/30 02/02 COFFEE SHOP #12 TROY MI 2401339DE05K6B4JY -7.12
02/07 02/10 WESTLAKE PAYMENT 888-7399192 CA 2442119DPS66FSTMF -441.22
02/14 02/17 WAFFLE HOUSE 2446 ROUND ROCK TX 2479338DX02GVXXZE -23.40
Total Purchases -$471.74
Other Card Activity
02/21 02/23 Refund Store Inc. 800-3680038 CA 7479338E401X6P3M4 $80.00
Total Other Card Activity $80.00
"""

# A generic checking-account layout: unsigned amounts + running balance column.
CHECKING_TEXT = """
Statement Period 01/01/2026 to 01/31/2026
Withdrawals and Debits
Date Description Amount Balance
01/05 CHECK CARD PURCHASE GROCERY MART 45.00 1,234.56
01/09 ONLINE PAYMENT ELECTRIC CO 90.12 1,144.44
Deposits and Credits
Date Description Amount Balance
01/15 DIRECT DEP EMPLOYER PAYROLL 1,500.00 2,644.44
"""


class StatementParseTest(unittest.TestCase):
    def parse(self, text):
        from app.importers import parse_statement_text, merge_rules
        return parse_statement_text(text, merge_rules([]))[0]

    def test_fidelity_style(self):
        txns = self.parse(STATEMENT_TEXT)
        amounts = {round(t["amount"], 2) for t in txns}
        # deposits, withdrawals, purchases, refund — all in
        self.assertEqual(len(txns), 8)
        for expected in (651.17, 940.29, -700.0, -38.96, -7.12, -441.22, -23.4, 80.0):
            self.assertIn(expected, amounts)
        # sweep lines excluded (the -700.00/651.17 sweeps duplicate real rows,
        # so check via descriptions too)
        self.assertFalse(any("You Sold" in t["description"] or "You Bought" in t["description"]
                             for t in txns))
        # post date wins over transaction date; period supplies the year
        coffee = next(t for t in txns if "COFFEE" in t["description"])
        self.assertEqual(coffee["date"], "2026-02-02")
        car = next(t for t in txns if "WESTLAKE" in t["description"])
        self.assertEqual(car["category"], "Debt Payment")
        payroll = next(t for t in txns if "Payroll" in t["description"])
        self.assertEqual(payroll["category"], "Income")

    def test_checking_style_signs_and_balance_column(self):
        txns = self.parse(CHECKING_TEXT)
        self.assertEqual(len(txns), 3)
        by_desc = {t["description"][:12]: t for t in txns}
        # unsigned amounts in a debits section become negative; balance ignored
        self.assertEqual(by_desc["CHECK CARD P"]["amount"], -45.0)
        self.assertEqual(by_desc["ONLINE PAYME"]["amount"], -90.12)
        self.assertEqual(by_desc["DIRECT DEP E"]["amount"], 1500.0)
        self.assertTrue(all(t["date"].startswith("2026-01") for t in txns))


class CreditReportParseTest(unittest.TestCase):
    def test_screening_report(self):
        from app.importers import parse_credit_report_text
        debts = parse_credit_report_text(SCREENING_REPORT_TEXT)
        by_name = {d["name"]: d for d in debts}
        self.assertEqual(len(debts), 4)
        lending = by_name["FIRST EXAMPLE LENDING"]
        self.assertEqual(lending["balance"], 12450.0)
        self.assertEqual(lending["min_payment"], 210.0)
        card = by_name["EXAMPLE BANK CARD"]
        self.assertEqual(card["balance"], 310.0)
        self.assertEqual(card["kind"], "credit_card")
        student = by_name["CAMPUS STUDENT LNS"]
        self.assertEqual(student["balance"], 6280.0)
        self.assertEqual(student["kind"], "student_loan")
        collection = by_name["CITY UTILITY DISTRICT (collection)"]
        self.assertEqual(collection["balance"], 842.0)
        # paid-off account skipped — nothing to pay down
        self.assertNotIn("PAIDOFF CARD CO", by_name)

    def test_three_bureau_report(self):
        from app.importers import parse_credit_report_text
        debts = parse_credit_report_text(TB_REPORT_TEXT)
        by_name = {d["name"]: d for d in debts}
        self.assertEqual(len(debts), 3, [d["name"] for d in debts])
        card = by_name["Example Bank Card"]
        self.assertEqual((card["balance"], card["kind"], card["account_last4"]),
                         (450.0, "credit_card", "5010"))
        self.assertEqual(card["apr"], 24.0)          # typical rate, flagged
        self.assertTrue(card["apr_estimated"])       # as an estimate
        auto = by_name["Example Auto Finance"]
        self.assertEqual((auto["balance"], auto["min_payment"], auto["term_months"], auto["kind"]),
                         (8100.0, 310.0, 48, "auto_loan"))  # max across bureaus
        # rate derived from $10,000 original / $310 x 48 payments, not guessed
        self.assertTrue(auto["apr_derived"])
        self.assertTrue(20 < auto["apr"] < 23, auto["apr"])
        col = by_name["Example Collections Co"]
        self.assertEqual((col["balance"], col["apr"]), (900.0, 0))  # merged, no APR guess

    def test_derive_apr(self):
        from app.importers import derive_apr
        # $10,000 at 10% APR over 60 months amortizes to $212.47/mo
        self.assertAlmostEqual(derive_apr(10000, 212.47, 60), 10.0, delta=0.05)
        # real-world subprime auto: $12,212 original, $441 x 42
        self.assertAlmostEqual(derive_apr(12212, 441, 42), 25.28, delta=0.05)
        # payments that only cover principal mean ~0%
        self.assertEqual(derive_apr(1000, 100, 10), 0.0)
        # nonsense inputs solve to nothing
        self.assertIsNone(derive_apr(0, 100, 12))
        self.assertIsNone(derive_apr(1000, 0, 12))
        self.assertIsNone(derive_apr(1000, 5000, 1))

    def test_debts_match(self):
        from app.importers import debts_match
        # masked account digits overlap + same balance
        self.assertTrue(debts_match(
            {"name": "Westlake Financial Svc", "balance": 9302, "account_last4": "0036"},
            {"name": "Westlake Service Inc", "balance": 9302, "account_last4": "36"}))
        # renamed across bureaus: shared words + same balance, no account info
        self.assertTrue(debts_match(
            {"name": "UAS/College Ave Studen", "balance": 31397},
            {"name": "College Avenue Stude", "balance": 31397}))
        # different cards stay separate
        self.assertFalse(debts_match(
            {"name": "Chase Freedom Visa", "balance": 3204},
            {"name": "Capital One Visa", "balance": 2450}))

    def test_ignores_plain_text_and_disclosures(self):
        from app.importers import parse_credit_report_text
        self.assertEqual(parse_credit_report_text(CREDIT_REPORT_TEXT), [])
        self.assertEqual(parse_credit_report_text("A Summary of Your Rights Under the "
                                                  "Fair Credit Reporting Act"), [])


class AdviceTest(unittest.TestCase):
    def test_stuck_debts_name_the_reason(self):
        from app.engine import simulate_payoff
        debts = [
            {"id": 1, "name": "Collection", "balance": 1000, "apr": 0, "min_payment": 0, "due_day": 1},
            {"id": 2, "name": "Toxic card", "balance": 5000, "apr": 36.0, "min_payment": 20, "due_day": 1},
        ]
        r = simulate_payoff(debts, "avalanche", 0)
        self.assertTrue(r["stuck"])
        reasons = {d["name"]: d["reason"] for d in r["stuck_debts"]}
        self.assertEqual(reasons["Collection"], "no_payment")
        self.assertEqual(reasons["Toxic card"], "interest")
        # with enough extra, both clear and stuck_debts empties
        ok = simulate_payoff(debts, "avalanche", 500)
        self.assertFalse(ok["stuck"])
        self.assertEqual(ok["stuck_debts"], [])

    def test_income_estimated_from_imported_statements(self):
        from app.engine import estimate_monthly_extra
        settings = {"monthly_net_income": "0", "pay_frequency": "biweekly",
                    "variable_budget": "400", "fun_pct": "0"}
        txns = [
            {"date": "2026-05-01", "amount": 2000.0, "category": "Income"},
            {"date": "2026-05-15", "amount": 2000.0, "category": "Income"},
            {"date": "2026-06-01", "amount": 2000.0, "category": "Income"},
            {"date": "2026-06-15", "amount": 2000.0, "category": "Income"},
            {"date": "2026-06-20", "amount": -50.0, "category": "Dining"},
        ]
        b = estimate_monthly_extra([], [], settings, [], txns)
        self.assertEqual(b["monthly_income"], 4000.0)
        self.assertEqual(b["monthly_extra"], 3600.0)
        # settings/paycheck income still wins when present
        b2 = estimate_monthly_extra([], [], settings | {"monthly_net_income": "3000"}, [], txns)
        self.assertEqual(b2["monthly_income"], 3000.0)


class CutPlanTest(unittest.TestCase):
    def make(self):
        txns = []
        for m in ("2026-05", "2026-06"):
            for day, desc, amt, cat in [
                ("02", "HULU 888-2658259", -15.49, "Subscriptions"),
                ("04", "DOORDASH*TACOS", -42.10, "Dining"),
                ("08", "DOORDASH*WINGS", -55.30, "Dining"),
                ("12", "DOORDASH*PIZZA", -61.00, "Dining"),
                ("05", "STARBUCKS #4411", -7.85, "Dining"),
                ("07", "STARBUCKS #4411", -9.10, "Dining"),
                ("11", "STARBUCKS #4411", -8.40, "Dining"),
                ("18", "STARBUCKS #4411", -11.25, "Dining"),
                ("21", "GOOGLE *Clash of Clans", -19.99, "Entertainment"),
                ("26", "GOOGLE *Clash of Clans", -39.99, "Entertainment"),
                ("24", "TARGET 00021", -41.00, "Shopping"),
                ("28", "KROGER #123", -180.00, "Groceries"),
            ]:
                txns.append({"date": f"{m}-{day}", "description": desc,
                             "amount": amt, "category": cat})
        return txns

    def test_merchant_level_plan(self):
        from app.importers import build_cut_plan
        items = build_cut_plan(self.make(), 6)
        plan = {i["label"]: i for i in items}
        # delivery apps: near-total cut (90%), brands grouped across order names
        dd = plan["DoorDash"]
        self.assertEqual(dd["action"], "eliminate")
        self.assertAlmostEqual(dd["suggested_cut"], 158.40 * 0.9, places=2)
        self.assertTrue(any("DOORDASH*PIZZA" in e and "$61.00" in e for e in dd["examples"]))
        # subscriptions: cancel the whole thing
        hulu = plan["Hulu"]
        self.assertEqual((hulu["action"], hulu["suggested_cut"]), ("cancel", 15.49))
        # mobile-game in-app purchases called out by name
        game = plan["Google Play in-app purchases"]
        self.assertEqual(game["action"], "eliminate")
        self.assertTrue(any("Clash of Clans" in e for e in game["examples"]))
        # habit: halve, not eliminate
        sbux = plan["Starbucks"]
        self.assertEqual(sbux["action"], "trim")
        self.assertAlmostEqual(sbux["suggested_cut"], sbux["monthly_avg"] / 2, places=2)
        # a same-priced monthly Target run is NOT a subscription to cancel
        self.assertEqual(plan["TARGET 00021"]["action"], "trim")

    def test_necessity_weighted_priority(self):
        from app.importers import build_cut_plan
        items = build_cut_plan(self.make(), 6)
        # ranked by priority = dollars x (1 - necessity) x frequency boost
        priorities = [i["priority"] for i in items]
        self.assertEqual(priorities, sorted(priorities, reverse=True))
        # pure-convenience delivery outranks everything
        self.assertEqual(items[0]["label"], "DoorDash")
        # groceries ARE suggested now, but only a 10% squeeze, ranked last
        groc = next(i for i in items if i["label"] == "Groceries")
        self.assertEqual(groc["action"], "squeeze")
        self.assertEqual(groc["necessity"], 0.85)
        self.assertAlmostEqual(groc["suggested_cut"], groc["monthly_avg"] * 0.1, places=2)
        self.assertEqual(items[-1]["label"], "Groceries")
        self.assertTrue(any("KROGER" in e for e in groc["examples"]))
        # a luxury worth less per month still beats the bigger essential cut
        self.assertLess(groc["priority"], plan_min := min(
            i["priority"] for i in items if i["action"] != "squeeze"))


class EngineTest(unittest.TestCase):
    def test_payoff_math(self):
        from app.engine import simulate_payoff
        debts = [
            {"id": 1, "name": "Card A", "balance": 1000, "apr": 24.0, "min_payment": 30, "due_day": 1},
            {"id": 2, "name": "Card B", "balance": 5000, "apr": 12.0, "min_payment": 100, "due_day": 1},
        ]
        base = simulate_payoff(debts, "avalanche", 0)
        boosted = simulate_payoff(debts, "avalanche", 300)
        self.assertLess(boosted["months"], base["months"])
        self.assertLess(boosted["total_interest"], base["total_interest"])
        self.assertEqual(boosted["payoff_order"][0]["name"], "Card A")  # highest APR first
        snow = simulate_payoff(debts, "snowball", 300)
        self.assertEqual(snow["payoff_order"][0]["name"], "Card A")  # also smallest here
        # avalanche never pays more interest than snowball
        self.assertLessEqual(boosted["total_interest"], snow["total_interest"] + 0.01)

    def test_stuck_detection(self):
        from app.engine import simulate_payoff
        debts = [{"id": 1, "name": "Bad", "balance": 10000, "apr": 30.0, "min_payment": 10, "due_day": 1}]
        result = simulate_payoff(debts, "avalanche", 0)
        self.assertTrue(result["stuck"])

    def test_next_due_date(self):
        from datetime import date
        from app.engine import next_due_date
        self.assertEqual(next_due_date(15, date(2026, 7, 1)), date(2026, 7, 15))
        self.assertEqual(next_due_date(15, date(2026, 7, 15)), date(2026, 7, 15))
        self.assertEqual(next_due_date(5, date(2026, 7, 20)), date(2026, 8, 5))
        self.assertEqual(next_due_date(10, date(2026, 12, 20)), date(2027, 1, 10))


if __name__ == "__main__":
    unittest.main(verbosity=2)
