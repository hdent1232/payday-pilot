"""Import + categorization: bank statement CSVs, credit report text/CSV,
keyword-based transaction categorization and spending analysis.
"""

import csv
import io
import re
from datetime import date, datetime, timedelta

# ------------------------------------------------------------ categorization

DEFAULT_RULES = [
    ("rent", "Housing"), ("mortgage", "Housing"), ("apartment", "Housing"),
    ("electric", "Utilities"), ("energy", "Utilities"), ("power", "Utilities"),
    ("water", "Utilities"), ("sewer", "Utilities"), ("gas co", "Utilities"),
    ("internet", "Utilities"), ("wifi", "Utilities"), ("comcast", "Utilities"),
    ("xfinity", "Utilities"), ("spectrum", "Utilities"), ("cox ", "Utilities"),
    ("verizon", "Phone"), ("t-mobile", "Phone"), ("tmobile", "Phone"), ("at&t", "Phone"),
    ("kroger", "Groceries"), ("walmart", "Groceries"), ("aldi", "Groceries"),
    ("costco", "Groceries"), ("trader joe", "Groceries"), ("publix", "Groceries"),
    ("safeway", "Groceries"), ("heb ", "Groceries"), ("wegmans", "Groceries"),
    ("whole foods", "Groceries"), ("grocery", "Groceries"), ("food lion", "Groceries"),
    ("shell", "Gas & Fuel"), ("chevron", "Gas & Fuel"), ("exxon", "Gas & Fuel"),
    ("bp ", "Gas & Fuel"), ("speedway", "Gas & Fuel"), ("circle k", "Gas & Fuel"),
    ("marathon", "Gas & Fuel"), ("fuel", "Gas & Fuel"),
    ("uber eats", "Dining"), ("uber * eats", "Dining"), ("uber *eats", "Dining"),
    ("ubereats", "Dining"),  # before the generic "uber" transport rule
    ("uber", "Transport"), ("lyft", "Transport"), ("parking", "Transport"),
    ("toll", "Transport"), ("transit", "Transport"),
    ("netflix", "Subscriptions"), ("spotify", "Subscriptions"), ("hulu", "Subscriptions"),
    ("disney", "Subscriptions"), ("youtube", "Subscriptions"), ("apple.com", "Subscriptions"),
    ("prime video", "Subscriptions"), ("audible", "Subscriptions"), ("patreon", "Subscriptions"),
    ("onlyfans", "Subscriptions"), ("hbo", "Subscriptions"), ("paramount", "Subscriptions"),
    ("mcdonald", "Dining"), ("starbucks", "Dining"), ("chipotle", "Dining"),
    ("chick-fil-a", "Dining"), ("taco bell", "Dining"), ("wendy", "Dining"),
    ("burger", "Dining"), ("pizza", "Dining"), ("doordash", "Dining"),
    ("grubhub", "Dining"), ("ubereats", "Dining"), ("uber eats", "Dining"),
    ("restaurant", "Dining"), ("cafe", "Dining"), ("diner", "Dining"), ("bar & grill", "Dining"),
    ("amazon", "Shopping"), ("target", "Shopping"), ("best buy", "Shopping"),
    ("ebay", "Shopping"), ("etsy", "Shopping"), ("temu", "Shopping"), ("shein", "Shopping"),
    ("gym", "Health & Fitness"), ("planet fitness", "Health & Fitness"),
    ("la fitness", "Health & Fitness"), ("pharmacy", "Health & Fitness"),
    ("cvs", "Health & Fitness"), ("walgreens", "Health & Fitness"),
    ("doctor", "Health & Fitness"), ("dental", "Health & Fitness"),
    ("geico", "Insurance"), ("progressive", "Insurance"), ("state farm", "Insurance"),
    ("allstate", "Insurance"), ("insurance", "Insurance"),
    ("steam", "Entertainment"), ("playstation", "Entertainment"), ("xbox", "Entertainment"),
    ("cinema", "Entertainment"), ("theatre", "Entertainment"), ("ticketmaster", "Entertainment"),
    ("365 market", "Dining"), ("aramark", "Dining"), ("waffle house", "Dining"),
    ("favor ", "Dining"), ("texaco", "Gas & Fuel"), ("valero", "Gas & Fuel"),
    ("7-eleven", "Gas & Fuel"), ("openai", "Subscriptions"), ("chatgpt", "Subscriptions"),
    ("rocketmoney", "Subscriptions"), ("rkt money", "Subscriptions"),
    ("xsolla", "Entertainment"), ("whop", "Entertainment"),
    ("hims", "Health & Fitness"), ("crunch fit", "Health & Fitness"),
    ("westlake", "Debt Payment"), ("uas epayment", "Debt Payment"),
    ("payroll", "Income"), ("direct dep", "Income"), ("paycheck", "Income"), ("salary", "Income"),
    ("dividend", "Income"),
    ("car payment", "Debt Payment"), ("loan pmt", "Debt Payment"), ("loan payment", "Debt Payment"),
    ("credit card pmt", "Debt Payment"), ("card payment", "Debt Payment"), ("autopay", "Debt Payment"),
    ("transfer", "Transfers"), ("zelle", "Transfers"), ("venmo", "Transfers"),
    ("cash app", "Transfers"), ("paypal", "Transfers"), ("atm", "Cash"),
]

DISCRETIONARY = {"Dining", "Subscriptions", "Shopping", "Entertainment", "Other", "Cash"}

# Recurring-but-essential categories that shouldn't be flagged as "likely
# subscriptions" (rent recurs every month; that's not a subscription to cancel).
ESSENTIAL_RECURRING = {"Housing", "Utilities", "Phone", "Insurance", "Groceries",
                       "Gas & Fuel", "Debt Payment", "Transfers", "Income"}


def categorize(description, rules):
    desc = description.lower()
    for r in rules:  # user rules first (caller puts them first)
        if r["keyword"] in desc:
            return r["category"]
    return "Other"


def merge_rules(user_rules):
    merged = [{"keyword": r["keyword"].lower(), "category": r["category"]} for r in user_rules]
    merged += [{"keyword": k, "category": c} for k, c in DEFAULT_RULES]
    return merged


# ------------------------------------------------------------ bank CSV import

DATE_COLS = ("date", "transaction date", "trans date", "posted date", "posting date", "post date")
DESC_COLS = ("description", "memo", "payee", "name", "details", "merchant", "transaction")
AMOUNT_COLS = ("amount", "transaction amount", "amt")
DEBIT_COLS = ("debit", "withdrawal", "withdrawals", "money out", "outflow")
CREDIT_COLS = ("credit", "deposit", "deposits", "money in", "inflow")

DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y", "%d/%m/%Y", "%b %d, %Y", "%d %b %Y")


def _parse_date(value):
    value = value.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _parse_money(value):
    value = value.strip().replace("$", "").replace(",", "")
    if not value:
        return None
    negative = value.startswith("(") and value.endswith(")")
    value = value.strip("()")
    try:
        num = float(value)
    except ValueError:
        return None
    return -num if negative else num


def _find_col(header, candidates):
    lowered = [h.strip().lower() for h in header]
    for cand in candidates:
        for i, h in enumerate(lowered):
            if h == cand:
                return i
    for cand in candidates:
        for i, h in enumerate(lowered):
            if cand in h:
                return i
    return None


def parse_bank_csv(text, rules):
    """Parse a bank/credit-card statement CSV into normalized transactions.

    Handles single signed 'Amount' columns as well as separate Debit/Credit
    columns. Amounts are stored with money-out negative.
    """
    reader = csv.reader(io.StringIO(text))
    lines = [row for row in reader if any(cell.strip() for cell in row)]
    if not lines:
        return [], "File is empty."

    header = lines[0]
    di = _find_col(header, DATE_COLS)
    if di is None:
        return [], "Couldn't find a date column. Expected a header row with a 'Date' column."
    desc_i = _find_col(header, DESC_COLS)
    amt_i = _find_col(header, AMOUNT_COLS)
    debit_i = _find_col(header, DEBIT_COLS)
    credit_i = _find_col(header, CREDIT_COLS)
    if amt_i is None and debit_i is None and credit_i is None:
        return [], "Couldn't find an Amount (or Debit/Credit) column."

    txns = []
    skipped = 0
    for row in lines[1:]:
        if len(row) <= di:
            skipped += 1
            continue
        d = _parse_date(row[di])
        if not d:
            skipped += 1
            continue
        desc = row[desc_i].strip() if desc_i is not None and len(row) > desc_i else "Transaction"
        amount = None
        if amt_i is not None and len(row) > amt_i:
            amount = _parse_money(row[amt_i])
        if amount is None:
            debit = _parse_money(row[debit_i]) if debit_i is not None and len(row) > debit_i else None
            credit = _parse_money(row[credit_i]) if credit_i is not None and len(row) > credit_i else None
            if debit:
                amount = -abs(debit)
            elif credit:
                amount = abs(credit)
        if amount is None:
            skipped += 1
            continue
        category = categorize(desc, rules)
        if amount > 0 and category == "Other":
            category = "Income"
        txns.append({"date": d, "description": desc, "amount": round(amount, 2),
                     "category": category})
    note = f"Skipped {skipped} unparseable row(s)." if skipped else ""
    return txns, note


# ------------------------------------------------------------ PDF statement import

# Transaction line: one or two leading M/D dates (trans + post), a description,
# and one or more trailing money tokens. When two money tokens end the line the
# last is a running balance and the one before it is the amount.
_MONEY_TOKEN = r"-?\(?\$?-?[\d,]{1,12}\.\d{2}\)?"
_STMT_LINE = re.compile(
    r"^\s*(\d{1,2}/\d{1,2}(?:/\d{2,4})?)"
    r"(?:\s+(\d{1,2}/\d{1,2}(?:/\d{2,4})?))?"
    r"\s+(.+?)"
    rf"\s+({_MONEY_TOKEN}(?:\s+{_MONEY_TOKEN})*)\s*$"
)
# Sections whose dated rows are not real cash flow (brokerage sweeps etc.).
_STMT_SKIP_ON = re.compile(r"core fund activity|estimated cash flow|^holdings\b", re.I)
_STMT_SKIP_OFF = re.compile(
    r"deposits|withdrawals|debit card|purchases|other card activity|dividends|"
    r"checks paid|atm|transactions", re.I)
_STMT_NEG_SECTION = re.compile(r"withdrawal|purchase|checks? paid|fees|debits|atm", re.I)
_STMT_POS_SECTION = re.compile(r"deposit|credit|addition|dividend|interest|other card activity", re.I)
_STMT_BAD_DESC = re.compile(r"you sold|you bought|morning trade|reinvest", re.I)
_STMT_BAD_START = ("total", "subtotal", "beginning", "ending", "balance", "date", "trans.")

_MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}


def _statement_period_end(text):
    """Find the statement period so M/D dates can be given the right year."""
    m = re.search(
        r"(?:January|February|March|April|May|June|July|August|September|October|"
        r"November|December)\s+\d{1,2},\s*\d{4}\s*[-–—]\s*"
        r"(January|February|March|April|May|June|July|August|September|October|"
        r"November|December)\s+(\d{1,2}),\s*(\d{4})", text, re.I)
    if m:
        return date(int(m.group(3)), _MONTHS[m.group(1).lower()], min(28, int(m.group(2))))
    m = re.search(
        r"\d{1,2}/\d{1,2}/(\d{2,4})\s*(?:-|–|—|to|through)\s*"
        r"(\d{1,2})/(\d{1,2})/(\d{2,4})", text)
    if m:
        year = int(m.group(4))
        if year < 100:
            year += 2000
        try:
            return date(year, int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def _statement_date(token, period_end):
    parts = token.split("/")
    month, day = int(parts[0]), int(parts[1])
    if len(parts) == 3:
        year = int(parts[2])
        if year < 100:
            year += 2000
        try:
            return date(year, month, day)
        except ValueError:
            return None
    ref = period_end or date.today()
    for year in (ref.year, ref.year - 1):
        try:
            d = date(year, month, day)
        except ValueError:
            continue
        if d <= ref + timedelta(days=35):
            return d
    return None


def parse_statement_text(text, rules):
    """Parse transactions out of bank/brokerage statement text (from a PDF).

    Works line by line with light section tracking: brokerage sweep sections
    are skipped, and unsigned amounts inherit the sign of their section
    (Withdrawals/Purchases are money out; Deposits are money in).
    """
    period_end = _statement_period_end(text)
    txns = []
    skipping = False
    section_sign = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _STMT_LINE.match(line)
        if not m:
            # Non-transaction line: maybe a section header.
            if len(line) < 80:
                if _STMT_SKIP_ON.search(line):
                    skipping = True
                elif _STMT_SKIP_OFF.search(line):
                    skipping = False
                    if _STMT_NEG_SECTION.search(line):
                        section_sign = -1
                    elif _STMT_POS_SECTION.search(line):
                        section_sign = 1
            continue
        if skipping:
            continue
        date1, date2, desc, money_group = m.groups()
        desc = re.sub(r"\s+", " ", desc).strip()
        low = desc.lower()
        if not desc or low.startswith(_STMT_BAD_START) or _STMT_BAD_DESC.search(low):
            continue
        tokens = money_group.split()
        raw_amount = tokens[-2] if len(tokens) >= 2 else tokens[-1]
        amount = _parse_money(raw_amount)
        if amount is None:
            continue
        if amount > 0 and "-" not in raw_amount and "(" not in raw_amount and section_sign < 0:
            amount = -amount
        when = _statement_date(date2 or date1, period_end)
        if not when:
            continue
        category = categorize(desc, rules)
        txns.append({"date": when.isoformat(), "description": desc[:120],
                     "amount": round(amount, 2), "category": category})
    note = "" if txns else ("No transactions found. If this statement is a scanned "
                            "image (not selectable text), it can't be read.")
    return txns, note


# ------------------------------------------------------------ credit report import

DEBT_NAME_COLS = ("name", "account", "account name", "creditor", "lender")
DEBT_BALANCE_COLS = ("balance", "amount owed", "current balance", "owed")
DEBT_APR_COLS = ("apr", "interest rate", "rate", "interest")
DEBT_MIN_COLS = ("min payment", "minimum payment", "monthly payment", "payment", "min_payment")
DEBT_TERM_COLS = ("term", "term months", "months", "term_months")
DEBT_DUE_COLS = ("due day", "due", "due_day")

KNOWN_CREDITORS = (
    "capital one", "chase", "discover", "amex", "american express", "citi", "citibank",
    "bank of america", "wells fargo", "synchrony", "credit one", "usaa", "navy federal",
    "us bank", "barclays", "goldman", "apple card", "affirm", "klarna", "afterpay",
    "upstart", "sofi", "lending club", "avant", "onemain", "ally", "santander",
    "toyota financial", "honda financial", "gm financial", "ford credit", "carmax",
    "nelnet", "navient", "mohela", "great lakes", "fedloan", "sallie mae", "earnest",
    "aidvantage", "student loan", "auto loan", "car loan", "personal loan", "medical",
    "credit card", "visa", "mastercard",
)


def parse_debts_csv(text):
    reader = csv.reader(io.StringIO(text))
    lines = [row for row in reader if any(cell.strip() for cell in row)]
    if len(lines) < 2:
        return []
    header = lines[0]
    ni = _find_col(header, DEBT_NAME_COLS)
    bi = _find_col(header, DEBT_BALANCE_COLS)
    if ni is None or bi is None:
        return []
    ai = _find_col(header, DEBT_APR_COLS)
    mi = _find_col(header, DEBT_MIN_COLS)
    ti = _find_col(header, DEBT_TERM_COLS)
    dui = _find_col(header, DEBT_DUE_COLS)

    def cell(row, i):
        return row[i].strip() if i is not None and len(row) > i else ""

    debts = []
    for row in lines[1:]:
        name = cell(row, ni)
        balance = _parse_money(cell(row, bi))
        if not name or balance is None:
            continue
        apr = _parse_money(cell(row, ai).replace("%", "")) or 0
        minp = _parse_money(cell(row, mi)) or 0
        term = cell(row, ti)
        due = cell(row, dui)
        debts.append({
            "name": name, "balance": abs(balance), "apr": apr, "min_payment": abs(minp),
            "term_months": int(float(term)) if term else None,
            "due_day": int(float(due)) if due else 1,
            "kind": "other",
        })
    return debts


MONEY_RE = r"\$?\s?([\d,]+(?:\.\d{1,2})?)"


def parse_debts_text(text):
    """Best-effort extraction of accounts + balances from pasted credit report text.

    Looks for known creditor names and grabs the balance / rate / payment
    figures near them. Anything found is presented for review before saving.
    """
    found = []
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for i, line in enumerate(lines):
        low = line.lower()
        creditor = next((c for c in KNOWN_CREDITORS if c in low), None)
        # Detail lines ("Balance: $X", "APR: Y%") describe the account named
        # above them — they are context, not accounts of their own.
        if not creditor and re.match(r"^(balance|amount|owed|apr|interest|min(imum)?|monthly|payment)\b", low):
            continue
        balance_m = re.search(r"(?:balance|owed|amount)\D{0,12}" + MONEY_RE, low)
        if not creditor and not balance_m:
            continue
        context = " ".join(lines[i:i + 4]).lower()
        balance_m = balance_m or re.search(r"(?:balance|owed|amount)\D{0,12}" + MONEY_RE, context)
        if not balance_m:
            money = re.search(MONEY_RE, context)
            balance_m = money if creditor and money else None
        if not balance_m:
            continue
        balance = float(balance_m.group(1).replace(",", ""))
        apr_m = re.search(r"([\d.]+)\s?%", context)
        min_m = re.search(r"(?:min(?:imum)?|monthly)\s?(?:payment|pmt)\D{0,12}" + MONEY_RE, context)
        name = line if not creditor else line[:60]
        entry = {
            "name": re.sub(r"\s+", " ", name)[:60],
            "balance": balance,
            "apr": float(apr_m.group(1)) if apr_m else 0,
            "min_payment": float(min_m.group(1).replace(",", "")) if min_m else 0,
            "term_months": None, "due_day": 1, "kind": "other",
        }
        if all(abs(f["balance"] - balance) > 0.01 or f["name"] != entry["name"] for f in found):
            found.append(entry)
    return found


# Bureau/tenant-screening reports (Experian, SafeRent, RentGrow, …) lay out
# each account as a "CREDITOR - Member # 123" header followed by labeled
# fields. pdf.js flattens the two-column layout into single lines, so fields
# are found by label anywhere in the account's block, not by position.
_CR_LABELS = (
    "Reported", "Type", "Industry", "Account\\s*#", "High Credit", "Credit Limit",
    "Payment", "Past Due", "Balance", "Months Reviewed", "Last Activity",
    "Original Loan Amount", "ECOA", "Narrative", "Opened", "Status",
    "Date Reported", "Agency Customer\\s*#", "Balance Due", "Past Due Amount",
    "Balance Date", "Account/Serial\\s*#", "Collection Agency",
    "Original Amount Owed",
)
_CR_LABEL_RE = "(?:" + "|".join(_CR_LABELS) + ")\\s*:"
_CR_TRADELINE_HEAD = re.compile(r"^[ \t\f]*(\S[^\n]{1,60}?)\s*[-–]\s*Member\s*#", re.M)
_CR_SECTION_END = re.compile(r"\b(?:Inquiries|Collections|Credit Report Serviced)\b")

_CR_STUDENT = ("college", "studen", "sallie", "navient", "nelnet", "mohela",
               "edfinancial", "aidvantage", "fedloan", "great lakes", "earnest", "uas")
_CR_AUTO = ("auto", "westlake", "toyota", "honda", "gm financial", "ford credit",
            "carmax", "car loan", "vehicle")


def _cr_money(label, chunk):
    m = re.search(r"(?<![A-Za-z])" + label + r"\s*:\s*\$?\s*" + MONEY_RE, chunk, re.I)
    return float(m.group(1).replace(",", "")) if m else None


def _cr_field(label, chunk):
    m = re.search(r"(?<![A-Za-z])" + label + r"\s*:\s*(.*?)(?=\s*" + _CR_LABEL_RE + r"|\n|$)",
                  chunk, re.I)
    return m.group(1).strip() if m else ""


def _cr_kind(name, type_, industry):
    s = f"{name} {industry}".lower()
    if any(k in s for k in _CR_STUDENT):
        return "student_loan"
    if any(k in s for k in _CR_AUTO):
        return "auto_loan"
    if type_.lower().startswith("revolv") or "credit card" in industry.lower():
        return "credit_card"
    if "medical" in s:
        return "medical"
    if "mortgage" in f"{type_} {industry}".lower():
        return "mortgage"
    return "other"


def _account_last4(raw):
    """Trailing digits of a masked account number ('xxxxxx 0036' -> '0036')."""
    digits = re.findall(r"(\d{2,})", raw or "")
    return digits[-1][-4:] if digits else ""


def _parse_screening_report(text):
    """The tradeline layout used by Experian-fed screening reports (SafeRent etc.)."""
    debts = []
    heads = list(_CR_TRADELINE_HEAD.finditer(text))
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else min(len(text), m.end() + 2500)
        block = text[m.end():end]
        term = _CR_SECTION_END.search(block)
        if term:
            block = block[:term.start()]
        balance = _cr_money("Balance", block)
        if not balance:
            continue
        name = re.sub(r"\s+", " ", m.group(1)).strip(" -")
        type_ = _cr_field("Type", block)
        industry = _cr_field("Industry", block)
        debts.append({
            "name": name[:60], "balance": balance, "apr": 0,
            "min_payment": _cr_money("Payment", block) or 0,
            "term_months": None, "due_day": 1,
            "kind": _cr_kind(name, type_, industry),
            "account_last4": _account_last4(_cr_field("Account\\s*#", block)),
        })
    # Collections: anchored on "Balance Due" with a collection marker nearby.
    # The creditor's name renders as the leading text of the rows between the
    # "Creditor:" label and the balance line (the left column of the layout).
    for m in re.finditer(r"(?<![A-Za-z])Balance Due\s*:\s*\$?\s*" + MONEY_RE, text, re.I):
        window = text[max(0, m.start() - 500):m.start()]
        after = text[m.end():m.end() + 300]
        if not re.search(r"collection", window + after, re.I):
            continue
        balance = float(m.group(1).replace(",", ""))
        if not balance:
            continue
        cred_matches = list(re.finditer(r"Creditor\s*:", window, re.I))
        parts = []
        if cred_matches:
            for ln in window[cred_matches[-1].end():].splitlines():
                lead = re.split(_CR_LABEL_RE, ln.strip(), maxsplit=1)[0].strip()
                if lead:
                    parts.append(lead)
        name = " ".join(parts)[:50] or _cr_field("Collection Agency", window) or "Collection account"
        debts.append({
            "name": f"{name} (collection)"[:60], "balance": balance, "apr": 0,
            "min_payment": 0, "term_months": None, "due_day": 1, "kind": "other",
            "account_last4": _account_last4(_cr_field("Account/Serial\\s*#", window + after)),
        })
    return debts


# Consumer bureau reports ("Three Bureau Credit Report", Equifax/Experian/
# TransUnion side-by-side columns) list accounts as numbered subsections
# ("4.1 Ed Financial/esa") with one labeled row per field and up to three
# values per row (one per bureau).
_TB_SUBHEAD = re.compile(r"^[ \t\f]*\d+\.\d+\s+([A-Za-z][A-Za-z&'./ -]{1,50}?)\s*(\(CLOSED\))?\s*$", re.M)
_TB_KINDS = (("student", "student_loan"), ("auto", "auto_loan"), ("creditcard", "credit_card"),
             ("credit card", "credit_card"), ("mortgage", "mortgage"), ("medical", "medical"))


def _tb_money_max(label, block):
    """Largest dollar value on the field's row (bureaus can disagree; be conservative)."""
    vals = []
    for m in re.finditer(label + r"((?:\s+(?:\$[\d,]+(?:\.\d{1,2})?|N/A)){1,3})", block):
        vals += [float(tok[1:].replace(",", "")) for tok in m.group(1).split() if tok.startswith("$")]
    return max(vals) if vals else None


def _parse_bureau_report(text):
    debts = []
    heads = list(_TB_SUBHEAD.finditer(text))
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else min(len(text), m.end() + 6000)
        block = text[m.end():end]
        balance = _tb_money_max("Reported Balance", block) or _tb_money_max(r"\bBalance\b", block)
        if not balance:
            continue
        name = re.sub(r"\s+", " ", m.group(1)).strip()
        loan_type = ""
        lt = re.search(r"Loan Type\s+([A-Za-z ]+)", block)
        if lt:
            loan_type = next((t for t in lt.group(1).split() if t.upper() != "N/A"), "")
        term = re.search(r"Term Duration\s+(\d+)", block)
        acct = re.search(r"Account Number\s+([^\n]+)", block)
        kind = next((k for key, k in _TB_KINDS if key in loan_type.lower()), "other")
        is_collection = "collection" in loan_type.lower() or bool(m.group(2))
        entry = {
            "name": name[:60] + (" (collection)" if is_collection and "collection" not in name.lower() else ""),
            "balance": balance, "apr": 0,
            "min_payment": _tb_money_max("Monthly Payment Amount", block) or 0,
            "term_months": int(term.group(1)) if term and int(term.group(1)) > 1 else None,
            "due_day": 1, "kind": kind,
            "account_last4": _account_last4(acct.group(1) if acct else ""),
        }
        # High Credit on an installment loan is the original amount, and with
        # the payment and term the contract rate falls out of the math.
        if not is_collection and entry["term_months"]:
            apr = derive_apr(_tb_money_max("High Credit", block), entry["min_payment"],
                             entry["term_months"])
            if apr:
                entry["apr"] = apr
                entry["apr_estimated"] = True
                entry["apr_derived"] = True
        debts.append(entry)
    return debts


# Typical APRs by debt type, used only when the document carries no rate
# (credit reports never do) AND the rate can't be derived from the loan's
# own numbers. Flagged apr_estimated so the review step and any later merge
# know the number is a guess, not data.
APR_ESTIMATES = {"credit_card": 24.0, "auto_loan": 10.0, "student_loan": 6.5,
                 "personal": 12.0, "mortgage": 7.0}


def derive_apr(principal, payment, months):
    """Contract APR implied by an amortized loan (solve payment equation for rate).

    Credit reports don't list rates, but original amount + monthly payment +
    term pin the rate down exactly. Bisection on the monthly rate; None when
    the inputs can't support a solve.
    """
    if not principal or not payment or not months or months < 2:
        return None
    if payment * months <= principal * 1.005:
        return 0.0  # payments barely exceed principal: effectively 0%
    lo, hi = 0.0, 0.06  # monthly; caps the answer at 72% APR
    for _ in range(80):
        mid = (lo + hi) / 2
        pv = payment * (1 - (1 + mid) ** -months) / mid
        if pv > principal:
            lo = mid
        else:
            hi = mid
    apr = round((lo + hi) / 2 * 12 * 100, 2)
    return apr if 0 < apr < 70 else None


def _norm_debt_name(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower().replace("(collection)", ""))


def debts_match(a, b):
    """Same real-world debt? Used to consolidate across documents and imports.

    Signals, strongest first: equal account last-4; overlapping masked account
    digits plus a corroborating name or balance; long shared name prefix;
    shared name words plus a near-equal balance.
    """
    l1 = (a.get("account_last4") or "").lstrip("0")
    l2 = (b.get("account_last4") or "").lstrip("0")
    n1, n2 = _norm_debt_name(a.get("name")), _norm_debt_name(b.get("name"))
    prefix = 0
    for c1, c2 in zip(n1, n2):
        if c1 != c2:
            break
        prefix += 1
    b1, b2 = float(a.get("balance") or 0), float(b.get("balance") or 0)
    close = b1 > 0 and b2 > 0 and abs(b1 - b2) <= 0.15 * max(b1, b2)
    if l1 and l2 and (l1.endswith(l2) or l2.endswith(l1)):
        if l1 == l2 and len(l1) >= 3:
            return True
        if prefix >= 4 or close:
            return True
    if prefix >= 8:
        return True
    if close:
        if prefix >= 5:
            return True
        # word-level overlap survives renames like "UAS/College Ave Studen"
        # vs "College Avenue Stude"
        w1 = {w for w in re.findall(r"[a-z0-9]{4,}", (a.get("name") or "").lower())}
        w2 = {w for w in re.findall(r"[a-z0-9]{4,}", (b.get("name") or "").lower())}
        hits = sum(1 for x in w1 for y in w2 if x == y or x in y or y in x)
        if hits >= 2:
            return True
    return False


def _consolidate(debts):
    """Merge entries that describe the same debt (bureaus list them repeatedly)."""
    merged = []
    for d in debts:
        dup = next((m for m in merged if debts_match(d, m)), None)
        if not dup:
            merged.append(dict(d))
            continue
        # keep the richer record, fill gaps from the other
        if not dup.get("min_payment") and d.get("min_payment"):
            dup["min_payment"] = d["min_payment"]
        if dup.get("kind") == "other" and d.get("kind") != "other":
            dup["kind"] = d["kind"]
        if not dup.get("term_months") and d.get("term_months"):
            dup["term_months"] = d["term_months"]
        if not dup.get("account_last4") and d.get("account_last4"):
            dup["account_last4"] = d["account_last4"]
        if d.get("apr") and (not dup.get("apr") or (d.get("apr_derived") and not dup.get("apr_derived"))):
            dup["apr"] = d["apr"]
            dup["apr_estimated"] = bool(d.get("apr_estimated"))
            dup["apr_derived"] = bool(d.get("apr_derived"))
        dup["balance"] = max(dup["balance"], d["balance"])
        if len(_norm_debt_name(d["name"])) > len(_norm_debt_name(dup["name"])) and "collection" not in d["name"].lower():
            dup["name"] = d["name"]
    return merged


def parse_credit_report_text(text):
    """Extract accounts + collections from a credit report's text (PDF or paste).

    Handles screening-report tradelines and three-bureau consumer reports.
    Duplicate listings of the same debt are consolidated. Credit reports never
    carry APRs, so a typical rate for the debt type is filled in and flagged
    apr_estimated for the review step. Zero-balance accounts are skipped.
    """
    debts = _parse_screening_report(text) or _parse_bureau_report(text)
    debts = _consolidate(debts)
    for d in debts:
        if not d["apr"] and "collection" not in d["name"].lower() and d["kind"] in APR_ESTIMATES:
            d["apr"] = APR_ESTIMATES[d["kind"]]
            d["apr_estimated"] = True
    return debts


# ------------------------------------------------------------ spending analysis

def spending_summary(transactions, months=6):
    """Monthly totals per category, recurring-charge detection and cut suggestions."""
    by_month = {}
    income_by_month = {}
    merchants = {}
    for t in transactions:
        month = t["date"][:7]
        if t["amount"] >= 0 or t["category"] in ("Transfers", "Debt Payment", "Income"):
            if t["amount"] > 0 and t["category"] == "Income":
                income_by_month[month] = income_by_month.get(month, 0) + t["amount"]
            continue
        spent = -t["amount"]
        cat = t["category"] or "Other"
        by_month.setdefault(month, {})
        by_month[month][cat] = by_month[month].get(cat, 0) + spent
        key = _normalize_merchant(t["description"])
        merchants.setdefault(key, []).append((month, spent, t["description"], cat))

    month_keys = sorted(by_month.keys())[-months:]
    by_month = {m: by_month[m] for m in month_keys}
    n_months = max(1, len(month_keys))

    cat_totals = {}
    for m in by_month.values():
        for cat, amt in m.items():
            cat_totals[cat] = cat_totals.get(cat, 0) + amt
    categories = [
        {
            "category": cat,
            "total": round(total, 2),
            "monthly_avg": round(total / n_months, 2),
            "discretionary": cat in DISCRETIONARY,
        }
        for cat, total in sorted(cat_totals.items(), key=lambda kv: -kv[1])
    ]

    recurring = []
    for key, hits in merchants.items():
        if hits[0][3] in ESSENTIAL_RECURRING:
            continue
        hit_months = {m for m, _, _, _ in hits}
        if len(hit_months) >= 2:
            amounts = [a for _, a, _, _ in hits]
            avg = sum(amounts) / len(amounts)
            spread = max(amounts) - min(amounts)
            if avg > 0 and spread <= max(2.0, avg * 0.25):
                recurring.append({
                    "merchant": hits[0][2][:48],
                    "monthly_avg": round(avg, 2),
                    "months_seen": len(hit_months),
                })
    recurring.sort(key=lambda r: -r["monthly_avg"])

    suggestions = build_cut_plan(transactions, months)

    return {
        "months": month_keys,
        "by_month": {m: {k: round(v, 2) for k, v in cats.items()} for m, cats in by_month.items()},
        "categories": categories,
        "income_by_month": {m: round(v, 2) for m, v in sorted(income_by_month.items())[-months:]},
        "recurring": recurring[:20],
        "suggestions": suggestions,
        "total_monthly_spend": round(sum(c["monthly_avg"] for c in categories), 2),
        "potential_monthly_savings": round(sum(s["suggested_cut"] for s in suggestions), 2),
    }


def _normalize_merchant(desc):
    d = re.sub(r"[#*\d]", "", desc.lower())
    d = re.sub(r"\s+", " ", d).strip()
    return d[:32]


# ------------------------------------------------------------ cut plan

# Known brands, grouped so "DOORDASH*TACOS" and "DOORDASH*WINGS" are one line.
# action: cancel = subscription you won't miss; eliminate = convenience premium
# with a cheap substitute (cut 100%); trim = habit to halve.
CUT_BRANDS = (
    ("doordash", "DoorDash", "eliminate"), ("uber eats", "Uber Eats", "eliminate"),
    ("uber *eats", "Uber Eats", "eliminate"), ("uber * eats", "Uber Eats", "eliminate"),
    ("ubereats", "Uber Eats", "eliminate"), ("grubhub", "Grubhub", "eliminate"),
    ("instacart", "Instacart", "eliminate"), ("postmates", "Postmates", "eliminate"),
    ("favor ", "Favor delivery", "eliminate"),
    ("netflix", "Netflix", "cancel"), ("hulu", "Hulu", "cancel"),
    ("spotify", "Spotify", "cancel"), ("disney", "Disney+", "cancel"),
    ("hbo", "HBO Max", "cancel"), ("paramount", "Paramount+", "cancel"),
    ("peacock", "Peacock", "cancel"), ("crunchyroll", "Crunchyroll", "cancel"),
    ("youtube", "YouTube Premium", "cancel"), ("audible", "Audible", "cancel"),
    ("patreon", "Patreon", "cancel"), ("onlyfans", "OnlyFans", "cancel"),
    ("openai", "ChatGPT", "cancel"), ("chatgpt", "ChatGPT", "cancel"),
    ("apple.com", "Apple subscriptions/in-app", "eliminate"),
    ("google play", "Google Play in-app purchases", "eliminate"),
    ("google *", "Google Play in-app purchases", "eliminate"),
    ("xsolla", "In-game purchases (Xsolla)", "eliminate"),
    ("playstation", "PlayStation purchases", "eliminate"),
    ("xbox", "Xbox purchases", "eliminate"), ("steam", "Steam purchases", "eliminate"),
    ("starbucks", "Starbucks", "trim"), ("dunkin", "Dunkin", "trim"),
    ("mcdonald", "McDonald's", "trim"), ("chick-fil-a", "Chick-fil-A", "trim"),
    ("taco bell", "Taco Bell", "trim"), ("chipotle", "Chipotle", "trim"),
    ("whataburger", "Whataburger", "trim"), ("wendy", "Wendy's", "trim"),
    ("raising cane", "Raising Cane's", "trim"), ("sonic", "Sonic", "trim"),
)

# Necessity-weighted priority: each move gets a cut fraction (how much of the
# spending to drop) and a necessity weight (0 = pure luxury, 1 = essential).
# Ranking uses dollars-freed x (1 - necessity) x a small frequency boost, so a
# $50 delivery habit outranks a $60 gas "optimization" — essentials are only
# squeezed after everything easier.
_CUT_RULES = {
    "eliminate": (0.9, 0.05),   # convenience premium, cheap substitute exists
    "cancel": (1.0, 0.10),      # subscriptions
    "trim": (0.5, 0.35),        # habits: go half as often
    "tail": (0.3, 0.50),        # category one-offs
    "squeeze": (0.1, 0.85),     # essentials: last resort, small shave
}
SQUEEZE_CATS = ("Groceries", "Gas & Fuel", "Transport")

_CUT_WORDING = {
    "cancel": "cancel it — a subscription you're paying every month",
    "eliminate": "cut 90% — pure convenience, a cheap substitute exists",
    "trim": "go half as often",
}


def _cut_priority(cut, necessity, per_month):
    freq = 1 + min(per_month or 0, 12) / 24  # frequent habits are easier to shave
    return round(cut * (1 - necessity) * freq, 2)


def _example_line(date, desc, amount):
    clean = re.sub(r"\s+", " ", desc).strip()[:28]
    return f"{date[5:]} {clean} ${amount:,.2f}"


def build_cut_plan(transactions, months=6):
    """Concrete, merchant-level plan for freeing money for debt.

    Instead of "cut the category in half": names the actual merchants with
    monthly amounts, how often they're hit, and example charges. Tiers the
    moves by pain: cancel subscriptions (painless), eliminate delivery/in-app
    convenience spending (cheap substitute exists), halve habits, then trim
    what's left of each category.
    """
    month_set = set()
    groups = {}
    cat_spend = {}
    squeeze = {}  # essential category -> {"total": $, "merchants": {label: $}}
    for t in transactions:
        if t["amount"] >= 0 or t["category"] not in DISCRETIONARY:
            if t["amount"] < 0 and t["category"] not in ("Transfers", "Debt Payment"):
                month_set.add(t["date"][:7])
                if t["category"] in SQUEEZE_CATS:
                    s = squeeze.setdefault(t["category"], {"total": 0, "merchants": {}})
                    label = re.sub(r"\s+", " ", t["description"]).strip()[:28]
                    s["total"] -= t["amount"]
                    s["merchants"][label] = s["merchants"].get(label, 0) - t["amount"]
            continue
        month = t["date"][:7]
        month_set.add(month)
        low = t["description"].lower()
        brand = next(((label, action) for kw, label, action in CUT_BRANDS if kw in low), None)
        key = brand[0] if brand else _normalize_merchant(t["description"])
        g = groups.setdefault(key, {
            "label": brand[0] if brand else re.sub(r"\s+", " ", t["description"]).strip()[:32],
            "action": brand[1] if brand else None,
            "category": t["category"], "hits": [],
        })
        g["hits"].append((month, -t["amount"], t["description"], t["date"]))
        cat_spend[t["category"]] = cat_spend.get(t["category"], 0) - t["amount"]

    month_keys = sorted(month_set)[-months:]
    n_months = max(1, len(month_keys))
    items = []
    for g in groups.values():
        hits = [h for h in g["hits"] if h[0] in month_keys] or g["hits"]
        total = sum(a for _, a, _, _ in hits)
        avg = total / n_months
        if avg < 10:
            continue
        per_month = len(hits) / n_months
        amounts = [a for _, a, _, _ in hits]
        action = g["action"]
        if not action:
            steady = (len({m for m, _, _, _ in hits}) >= 2 and per_month <= 1.5
                      and max(amounts) - min(amounts) <= max(2.0, (total / len(hits)) * 0.25))
            # a steady monthly charge is only "cancel a subscription" advice
            # when it lives in a subscription-ish category — a same-priced
            # monthly Target run is a habit, not a membership
            if steady and g["category"] in ("Subscriptions", "Entertainment", "Other"):
                action = "cancel"
            elif per_month >= 4 or avg >= 40:
                action = "trim"
            else:
                continue  # small one-offs roll into the category tail
        fraction, necessity = _CUT_RULES[action]
        cut = avg * fraction
        biggest = sorted(hits, key=lambda h: -h[1])[:3]
        items.append({
            "action": action, "label": g["label"], "category": g["category"],
            "monthly_avg": round(avg, 2), "suggested_cut": round(cut, 2),
            "necessity": necessity,
            "priority": _cut_priority(cut, necessity, per_month),
            "per_month": round(per_month, 1), "months_seen": len({m for m, _, _, _ in hits}),
            "message": f"${avg:,.0f}/mo across {per_month:.0f} charge(s)/mo — "
                       + _CUT_WORDING[action],
            "examples": [_example_line(d, desc, a) for _, a, desc, d in biggest],
        })

    # what's left of each category after the named merchants above
    for cat, total in cat_spend.items():
        named = sum(i["monthly_avg"] for i in items if i["category"] == cat)
        rest = total / n_months - named
        if rest >= 30:
            fraction, necessity = _CUT_RULES["tail"]
            tail = sorted((g for g in groups.values()
                           if g["category"] == cat and not any(i["label"] == g["label"] for i in items)),
                          key=lambda g: -sum(a for _, a, _, _ in g["hits"]))[:3]
            items.append({
                "action": "trim", "label": f"Other {cat}", "category": cat,
                "monthly_avg": round(rest, 2), "suggested_cut": round(rest * fraction, 2),
                "necessity": necessity,
                "priority": _cut_priority(rest * fraction, necessity, None),
                "per_month": None, "months_seen": n_months,
                "message": f"${rest:,.0f}/mo of one-offs — aim 30% lower",
                "examples": [f"{g['label']} ${sum(a for _, a, _, _ in g['hits']) / n_months:,.0f}/mo"
                             for g in tail],
            })

    # essentials last: real money, but you need to eat and get to work, so
    # only a small shave and always ranked after every discretionary cut
    for cat, s in squeeze.items():
        avg = s["total"] / n_months
        fraction, necessity = _CUT_RULES["squeeze"]
        cut = avg * fraction
        if cut < 12:
            continue
        top = sorted(s["merchants"].items(), key=lambda kv: -kv[1])[:3]
        items.append({
            "action": "squeeze", "label": cat, "category": cat,
            "monthly_avg": round(avg, 2), "suggested_cut": round(cut, 2),
            "necessity": necessity,
            "priority": _cut_priority(cut, necessity, None),
            "per_month": None, "months_seen": n_months,
            "message": f"${avg:,.0f}/mo — essential, so it's last in line; cheaper "
                       f"brands or fewer trips could shave ~10%",
            "examples": [f"{label} ${amt / n_months:,.0f}/mo" for label, amt in top],
        })

    items.sort(key=lambda i: -i["priority"])
    return items[:10]
