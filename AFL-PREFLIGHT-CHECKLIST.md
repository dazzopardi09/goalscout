# GoalScout — AFL Feasibility Pre-Flight Checklist

**Date:** 29 April 2026
**Type:** Operational checklist. Run before committing any modelling work.
**Goal:** Confirm or deny that the three required data sources are viable for the AFL line feasibility study.
**Time budget:** Half a day (3–4 hours). Stop and record findings; do not start modelling.

---

## What you're checking and why

| Source | What it gates |
|---|---|
| AusSportsBetting xlsx | Historical closing-line and closing-total odds 2013–present. Without this, the backtest CLV comparison has no ground truth. |
| fitzRoy `fetch_betting_odds_footywire` | Whether fitzRoy can supplement or replace AusSportsBetting for H2H odds, and whether it adds anything (market type, timestamps, bookmaker names) that AusSportsBetting lacks. |
| The Odds API — AFL live | Whether live closing-odds capture (for paper-trading) is achievable for the line and total markets, and which AU bookmakers are present. |

Run all three in sequence. Record results in the decision table at the end of this document.

---

## Source 1: AusSportsBetting AFL xlsx

### Where to get it

Manual download only. Navigate to:
```
https://www.aussportsbetting.com/data/historical-afl-results-and-odds-data/
```
Click the xlsx download link. The file is free for personal, non-commercial use. No registration required at time of writing.

**Terms of use note:** The page states data is for personal use only and must not be redistributed. This is consistent with a private research project running on a local Unraid server. It is not consistent with a commercial product, a publicly accessible tool, or sharing the downloaded file with others. Document this explicitly before the study begins. If GoalScout ever moves toward a commercial product, re-evaluate this dependency.

### Step 1 — Open and read the Notes sheet

Before touching the main data sheet, read the Notes sheet in the workbook. It documents the column names, data sources, and any caveats. This is the authoritative reference. Take a screenshot or copy the text.

### Step 2 — Check the schema (Python)

```python
import pandas as pd

# Load the full workbook to see sheet names
xl = pd.ExcelFile("afl.xlsx")
print(xl.sheet_names)
# Expect something like: ['AFL', 'Notes'] or ['Data', 'Notes']

# Load the main data sheet
df = pd.read_excel("afl.xlsx", sheet_name=0)

# Print all column names
print(df.columns.tolist())

# Print the first 3 rows of a post-2013 season
post2013 = df[df['Date'].dt.year >= 2013] if 'Date' in df.columns else df
print(post2013.head(3).to_string())

# Row count per year
print(df.groupby(df['Date'].dt.year).size())
```

### Step 3 — Confirm the 2013+ columns specifically

The page description says: *"The 2013 season and onward also include opening, minimum, maximum and closing odds for head-to-head, line and total score markets."*

Run:
```python
# List columns that contain keywords for what we need
target_keywords = ['open', 'min', 'max', 'clos', 'line', 'total', 'h2h', 'spread']
relevant_cols = [c for c in df.columns if any(k in c.lower() for k in target_keywords)]
print("Relevant columns:", relevant_cols)

# On post-2013 rows, check null rate for each relevant column
post2013 = df[pd.to_datetime(df['Date']).dt.year >= 2013]
null_rates = post2013[relevant_cols].isnull().mean().round(3)
print("\nNull rates (post-2013):")
print(null_rates)

# Spot-check a known match
# e.g., 2024 Round 1 Collingwood vs Carlton
sample = post2013[
    (pd.to_datetime(post2013['Date']).dt.year == 2024) &
    (post2013.iloc[:, 2].str.contains('Collingwood|Carlton', na=False) | 
     post2013.iloc[:, 3].str.contains('Collingwood|Carlton', na=False))
].head(3)
print("\nSample 2024 row(s):")
print(sample.to_string())
```

### Step 4 — Verify the line columns contain point values, not just odds

Line columns should contain values like `-12.5`, `+5.5`, not `1.91`, `1.91`. Confirm:

```python
# Identify the line columns from what you found above
# Replace 'Home Line Close' etc. with the actual column names from the Notes sheet
# This is illustrative — use the actual column names you find

line_cols = [c for c in relevant_cols if 'line' in c.lower()]
print("Line columns:", line_cols)

if line_cols:
    print(post2013[line_cols].describe())
    print(post2013[line_cols].head(10).to_string())
```

The values should cluster around 0 (a point handicap, often ±6 to ±40). If they cluster around 1.85–2.00, those are odds, not handicap values, and you need to look for a separate column that holds the handicap point value.

### Step 5 — Verify the total column contains a line value, not just odds

Total columns should contain a figure like `164.5`, `171.5`, not odds like `1.91`.

```python
total_cols = [c for c in relevant_cols if 'total' in c.lower()]
print("Total columns:", total_cols)

if total_cols:
    print(post2013[total_cols].describe())
```

Values should be in roughly the 140–195 range (typical AFL total-score lines). If they look like decimal odds, the structure is different from what the page description implies.

### Step 6 — Check whether bookmaker is identifiable per row

```python
# Look for a bookmaker/source column
bookie_cols = [c for c in df.columns if any(k in c.lower() for k in ['book', 'source', 'survey'])]
print("Bookmaker columns:", bookie_cols)

if bookie_cols:
    print(post2013[bookie_cols].value_counts())
```

Expectation: there is probably a "Bookmakers Surveyed" column that names the source (likely an aggregate of several Australian books), not per-bookmaker prices. This matters for interpreting what "closing price" means.

### What counts as pass / warn / fail

| Check | ✅ Pass | ⚠️ Warn | ❌ Fail |
|---|---|---|---|
| File downloads freely | Yes | Paywall appeared; still downloadable via free registration | Requires paid subscription |
| Notes sheet present and readable | Yes | Present but minimal documentation | Absent |
| Post-2013 rows have closing-line column | Yes, ≤5% nulls | 6–20% nulls (interpolation possible) | Column absent or >20% null |
| Post-2013 rows have closing-total column | Yes, ≤5% nulls | 6–20% nulls | Column absent or >20% null |
| Line column contains point values (not odds) | Values in range −60 to +60 | Ambiguous — could be either | Values cluster around 1.85–2.10 (these are odds, not points) |
| Total column contains total-score value | Values in range 130–200 | — | Values cluster like decimal odds |
| 2024 season is present | Yes | Last season is 2023 | Last season ≤ 2022 |
| Terms of use permit private research | Personal non-commercial use | Ambiguous | Explicitly prohibits research / analysis |

---

## Source 2: fitzRoy `fetch_betting_odds_footywire`

### Purpose in the pre-flight

Not to replace AusSportsBetting — that decision is already made. The goal here is to understand *what fitzRoy's odds function actually returns*, so we know whether it's useful as a supplementary source, useless, or contradictory.

### Environment setup (R)

```r
# If not already installed
install.packages("fitzRoy")
library(fitzRoy)
```

### Step 1 — Fetch one season

Fetch 2024 only. Don't pull a large range before you know what the function returns.

```r
odds_2024 <- fetch_betting_odds_footywire(start_season = 2024, end_season = 2024)
```

**If this throws an error or returns `NULL`:** fitzRoy's odds function may be broken or Footywire may have changed its structure. Note the error message and skip to the decision table (this would be a Warn at worst, not a Fail — AusSportsBetting is the primary source).

### Step 2 — Inspect the structure

```r
# Column names
names(odds_2024)

# First 5 rows, all columns
print(head(odds_2024, 5))

# Row count
nrow(odds_2024)
# Expect: ~207 if it includes finals; ~198 if home-and-away only; could be different if it has multiple odds per match

# Data types
str(odds_2024)

# All unique values in any categorical columns
# Try to identify a "market" or "type" column
sapply(odds_2024[sapply(odds_2024, is.character)], function(x) unique(x)[1:10])
```

### Step 3 — Count rows per match

The key question: does this function return one row per match (with odds in columns), or one row per market type per match?

```r
# If there's a date and team columns, count rows per match
# Adjust column names to match what names() showed you above
if ("Date" %in% names(odds_2024)) {
  rows_per_match <- table(odds_2024$Date, odds_2024$Home.Team)
  print(summary(as.vector(rows_per_match)))
}
```

If there are consistently 2 rows per match (home + away), this is team-level format. If there are 6+ rows per match, it may include multiple market types.

### Step 4 — Check for line and total fields

```r
# Are there any columns that could contain line or total values?
line_like <- names(odds_2024)[grep("line|spread|hcap|handicap|total|over|under", 
                                    names(odds_2024), ignore.case = TRUE)]
print(line_like)

# Check null rate on all columns
colMeans(is.na(odds_2024))
```

### Step 5 — Check for timestamps

```r
# Any timestamp/datetime columns?
ts_cols <- names(odds_2024)[sapply(odds_2024, function(x) inherits(x, c("POSIXct","POSIXlt","Date")))]
print(ts_cols)
```

If there are no timestamp columns beyond a match date, the odds are a snapshot of unknown timing — you cannot determine whether they are opening or closing prices.

### Step 6 — Cross-reference one match against AusSportsBetting

Pick one match from 2024 where you already know the result (e.g., Round 1 Collingwood vs Carlton). Compare the H2H odds fitzRoy returns with the H2H closing odds in the AusSportsBetting xlsx.

```r
# Example - adjust team names and date to match fitzRoy's naming convention
sample_match <- odds_2024[grep("Collingwood|Carlton", odds_2024$Home.Team, ignore.case = TRUE), ]
print(sample_match)
```

If the odds are similar to AusSportsBetting's closing price (within ~1–2%), Footywire likely records a near-closing snapshot. If they're very different from the close but close to an early-week price, they're openers or mid-week.

### What counts as pass / warn / fail

| Check | ✅ Pass | ⚠️ Warn | ❌ Fail |
|---|---|---|---|
| Function runs without error | Yes | Error but recoverable (e.g., rate limit) | Hard error / returns NULL |
| Returns ~200 rows for 2024 (≥1 row/match) | 195–215 | <195 or >500 (implies multi-row per match format we haven't seen) | 0 rows |
| Column names are self-explanatory | Includes line/total/handicap columns | H2H only, but content and timing identifiable | Completely opaque (no documentation matches) |
| Has line or total odds columns | Yes | H2H only (still useful as sanity check) | Only a single unlabelled "odds" column |
| Has timestamps | Yes | Date only (no time) | No date at all |
| Cross-reference to AusSportsBetting: H2H odds match closing within 3% | Yes | Within 5–8% (mid-week snapshot, usable with caveat) | Off by >10% (probably openers) |

**Note:** fitzRoy is supplementary, not primary. A Fail here doesn't stop the study — it just confirms we rely entirely on AusSportsBetting for historical odds. A Pass or Warn here is useful information, not a requirement.

---

## Source 3: The Odds API — AFL live endpoint

### Purpose in the pre-flight

Confirms whether live AFL odds (for future paper-trading) are accessible with AU bookmakers via The Odds API, specifically for spreads (line) and totals markets. Without this, paper-trading the line market requires manual closing-line capture, which is possible but much more painful.

### Step 1 — Confirm AFL is active (0 credits)

```bash
curl "https://api.the-odds-api.com/v4/sports?apiKey=YOUR_API_KEY&all=false" \
  | python3 -m json.tool \
  | grep -A 5 "aussierules_afl"
```

In Python:
```python
import requests

API_KEY = "YOUR_API_KEY_HERE"

resp = requests.get(
    "https://api.the-odds-api.com/v4/sports",
    params={"apiKey": API_KEY}
)
sports = resp.json()

afl = [s for s in sports if s.get("key") == "aussierules_afl"]
print(afl)

# Also check remaining credits
print("Requests remaining:", resp.headers.get("x-requests-remaining"))
print("Requests used:", resp.headers.get("x-requests-used"))
```

**Expected response:**
```json
[{
  "key": "aussierules_afl",
  "group": "Aussie Rules",
  "title": "AFL",
  "description": "Aussie Football",
  "active": true,
  "has_outrights": false
}]
```

If `"active": false`, the market is not currently open for betting (off-season check — but AFL season runs March–October so it should be active now). This costs 0 credits.

### Step 2 — H2H only, AU region (1 credit)

```python
resp_h2h = requests.get(
    "https://api.the-odds-api.com/v4/sports/aussierules_afl/odds",
    params={
        "apiKey": API_KEY,
        "regions": "au",
        "markets": "h2h",
        "oddsFormat": "decimal"
    }
)

data_h2h = resp_h2h.json()

# How many events returned?
print(f"Events returned: {len(data_h2h)}")

# What bookmakers appear across all events?
all_books = set()
for event in data_h2h:
    for bm in event.get("bookmakers", []):
        all_books.add(bm["key"])
print("Bookmakers found:", sorted(all_books))

# Sample first event
if data_h2h:
    e = data_h2h[0]
    print(f"\nSample event: {e['home_team']} vs {e['away_team']}")
    print(f"  Commence: {e['commence_time']}")
    for bm in e.get("bookmakers", [])[:3]:
        print(f"  Book: {bm['title']}")
        for mkt in bm.get("markets", []):
            print(f"    Market: {mkt['key']}, outcomes: {mkt['outcomes']}")

# Credits used
print("\nCredits remaining:", resp_h2h.headers.get("x-requests-remaining"))
```

### Step 3 — Add spreads and totals for ONE event (3 credits)

Do NOT use the broadcast `/odds` endpoint for spreads+totals — that costs 3 credits × number of events. Use the per-event endpoint instead, which costs 3 credits total for one event.

```python
# Get an event ID from the h2h results above
if data_h2h:
    event_id = data_h2h[0]["id"]
    print(f"Testing event: {event_id}")

    resp_full = requests.get(
        f"https://api.the-odds-api.com/v4/sports/aussierules_afl/events/{event_id}/odds",
        params={
            "apiKey": API_KEY,
            "regions": "au",
            "markets": "h2h,spreads,totals",
            "oddsFormat": "decimal"
        }
    )

    event_data = resp_full.json()

    # What markets actually came back per bookmaker?
    for bm in event_data.get("bookmakers", []):
        markets_returned = [m["key"] for m in bm.get("markets", [])]
        print(f"  {bm['title']}: {markets_returned}")

    # Credits
    print("\nCredits remaining:", resp_full.headers.get("x-requests-remaining"))
```

**Total API credits spent in this pre-flight: 1 (h2h broadcast) + 3 (one event, 3 markets) = 4 credits maximum.**

### What you need to see

**For `h2h`:**
- At least 3 AU bookmakers present: ideally Sportsbet (`sportsbet`), Bet365 (`bet365`), TAB (`tab`), Ladbrokes (`ladbrokes`)
- Events have `commence_time` in the future (or close to it — AFL Round 8 is this week in 2026)
- Odds format is decimal, values between 1.50 and 3.00 for most AFL matches

**For `spreads` (line):**
- At least 1 AU bookmaker returns the `spreads` market
- The `point` field is populated (e.g., `{"name": "Collingwood", "price": 1.91, "point": -8.5}`)
- Point values are in the range −60 to +60

**For `totals`:**
- At least 1 AU bookmaker returns the `totals` market
- Outcomes include "Over" and "Under" with a `point` value (e.g., `164.5`)

### What counts as pass / warn / fail

| Check | ✅ Pass | ⚠️ Warn | ❌ Fail |
|---|---|---|---|
| `aussierules_afl` is active | Yes | Yes but shows 0 upcoming events | Key not found or `"active": false` |
| H2H: ≥3 AU bookmakers | 4+ books including Bet365 or Sportsbet | 2–3 books, no Bet365/Sportsbet | 0–1 books, or only overseas books |
| H2H: prices look correct | Decimal 1.50–3.50 range | Decimal but only one side of the market | Malformed or clearly wrong |
| Spreads market returned | At least 1 book, `point` field populated | 1 book, `point` field populated | Empty array for spreads |
| Totals market returned | At least 1 book, `point` field populated | 1 book, `point` field populated | Empty array for totals |
| credits cost ≤ 4 | Confirmed | — | Would exceed 4 if you run the broadcast endpoint with all 3 markets — avoid this |

---

## Decision table

Fill in after running all three source checks. This determines whether you proceed.

| | AusSportsBetting xlsx | fitzRoy odds | The Odds API: H2H AU | The Odds API: spreads | The Odds API: totals |
|---|---|---|---|---|---|
| **Result** | _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ |

### Light rules

**🟢 Green — proceed to AFL line feasibility study**

All of the following must be true:
1. AusSportsBetting xlsx: closing-line column present, ≤10% nulls post-2013, point values confirmed (not odds).
2. AusSportsBetting xlsx: download free, terms consistent with private research.
3. The Odds API H2H: ≥3 AU bookmakers, prices correct.
4. At least one of (spreads, totals) returns at least 1 AU bookmaker with `point` field.

fitzRoy result does not affect the green/amber/red outcome — it's a nice-to-have.

**🟡 Amber — proceed with named caveats, no unresolved unknowns**

Proceed if AusSportsBetting passes AND at least one caveat applies that changes execution but doesn't kill the study:

- AusSportsBetting closing-line column: 10–25% nulls post-2013. *Caveat: use max odds as proxy for close on missing rows; document substitution rule before starting.*
- The Odds API spreads/totals: empty for AU region. *Caveat: live paper-trading must use manual closing-line capture (scrape TAB website or note the final line from Betfair AU match-odds market). Document this method explicitly before starting.*
- fitzRoy returns no line market data at all. *Caveat: fitzRoy used only for fixtures, results, lineups. No impact on study viability.*
- AusSportsBetting 2024 season absent (most recent season is 2023). *Caveat: use 2024 line odds from The Odds API historical endpoint as supplement — requires Business plan ($99/month).*

An amber light requires you to write down the named caveat and the specific workaround before starting. Do not start with "we'll figure it out."

**🔴 Red — stop AFL track, redirect effort**

Stop if any of the following:
1. AusSportsBetting closing-line column is absent entirely — there is no substitute free historical source for AFL closing-line odds at this quality.
2. AusSportsBetting closing-total column is absent — this kills the totals market track.
3. AusSportsBetting requires a paid subscription to download.
4. The Odds API: `aussierules_afl` is not an active sport, or returns zero AU bookmakers on H2H — paper-trading is impossible without live odds.
5. After reading the Notes sheet: the "closing" price is actually a Friday or Tuesday mid-week snapshot without a fixed time, making the backtest comparison meaningless — we'd be backtesting against neither opener nor closer, but an arbitrary mid-week price.

**If red:** Record the reason. Return to the strategy memo. The next highest-priority track (the soccer hybrid model / Understat xG layer) does not depend on any of these three sources and can start immediately.

---

## What to record

When the pre-flight is done, commit a short `AFL-PREFLIGHT-RESULTS.md` to the repo (next to `PROJECT-STATUS.md`) with:

```markdown
## AFL Pre-Flight Results — DATE

### AusSportsBetting xlsx
- File downloaded: yes/no
- Terms noted: [quote the personal-use clause]
- Seasons covered: YYYY–YYYY
- Line closing column name: [actual column name]
- Total closing column name: [actual column name]  
- Null rate on line close, post-2013: X%
- Null rate on total close, post-2013: X%
- Line column confirms point values: yes/no, range [MIN–MAX]
- Total column confirms score-total values: yes/no, range [MIN–MAX]
- Bookmaker identified per row: yes/no, value: [NAME or "aggregate"]
- Result: PASS / WARN / FAIL
- If warn: named caveat: [TEXT]

### fitzRoy fetch_betting_odds_footywire
- Ran without error: yes/no
- Rows returned for 2024: N
- Column names: [list]
- Markets identifiable: yes/no
- Timestamps present: yes/no
- H2H cross-reference vs AusSportsBetting close: within [X]%
- Result: PASS / WARN / FAIL / N/A (doesn't affect study go/no-go)

### The Odds API
- aussierules_afl active: yes/no
- H2H AU bookmakers: [list]
- Spreads returned: yes/no, books: [list]
- Totals returned: yes/no, books: [list]
- Credits consumed: N
- Result: PASS / WARN / FAIL

### Overall decision: 🟢 / 🟡 / 🔴
Caveats (if amber): [list]
Next step: [proceed to feasibility study / redirect to soccer hybrid]
```

Do not start the feasibility study until this file is committed.
