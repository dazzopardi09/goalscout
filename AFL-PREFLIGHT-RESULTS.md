# AFL Pre-Flight Results

**Date:** 29 April 2026  
**Branch:** `docs/afl-preflight-checklist`  
**Status:** In progress  
**Purpose:** Record findings from the AFL data-source pre-flight before any modelling work begins.

---

## 1. AusSportsBetting xlsx

**File:** `data/research/afl/aussportsbetting-afl.xlsx`  
**Workbook sheets:** `Data`, `Notes`  
**Data shape:** 3,416 rows × 52 columns  
**Coverage:** 2009–2026

### Key schema findings

Headers are on Excel row 2, so the workbook must be read with `header=1`.

Confirmed columns include:

- `Home Odds Close`
- `Away Odds Close`
- `Home Line Close`
- `Away Line Close`
- `Home Line Odds Close`
- `Away Line Odds Close`
- `Total Score Close`
- `Total Score Over Close`
- `Total Score Under Close`

### Season row counts

- 2009: 92
- 2010: 186
- 2011: 196
- 2012: 207
- 2013: 207
- 2014: 207
- 2015: 206
- 2016: 207
- 2017: 207
- 2018: 207
- 2019: 207
- 2020: 162
- 2021: 207
- 2022: 207
- 2023: 216
- 2024: 216
- 2025: 216
- 2026: 63 partial season

### Post-2013 null rates

| Field | Null rate |
|---|---:|
| `Home Line Close` | 0.073% |
| `Away Line Close` | 0.073% |
| `Home Line Odds Close` | 0.073% |
| `Away Line Odds Close` | 0.073% |
| `Total Score Close` | 7.605% |
| `Total Score Over Close` | 7.605% |
| `Total Score Under Close` | 7.605% |
| `Home Odds Close` | 0.000% |
| `Away Odds Close` | 0.000% |

### Value checks

- Line columns contain point handicap values such as `-12.5`, `25.5`, etc.
- Total score columns contain AFL total-score line values such as `184.5`, `189.5`, etc.
- H2H and line odds are decimal odds.
- Some odds outliers exist and will require cleaning rules:
  - line odds with `0.000`
  - H2H odds with `1.000`
  - extreme total over/under prices

### Notes sheet findings

Terms/caveats from the workbook:

- Data may contain errors.
- Users are told not to rely on the data for wagering decisions.
- Data is intended for personal use only.
- The data must not be made available on another website.
- The line and total score figures are paired with their corresponding odds fields. For example, `Home Line Min` is paired with `Home Line Odds Min`.
- The workbook references bet365 and Pinnacle Sports data services, plus OddsPortal historical odds.

### Assessment

**Result:** 🟢 Green with caveats.

AusSportsBetting is viable as the primary historical odds source for AFL line/spread feasibility testing.

**Caveats:**

- Do not commit the `.xlsx` file to the repo.
- Use only for private research unless licensing changes.
- Include cleaning rules for invalid odds.
- Do not hardcode expected matches per season.
- Totals are usable but have more missing data than line/spread.
- Treat 2026 as partial/in-progress only.

---

## 2. fitzRoy `fetch_betting_odds_footywire`

**Status:** Checked.

### Environment

Initial Docker run failed because the base R container was missing system libraries required to compile `curl`, `xml2`, `openssl`, `httr`, `httr2`, and `rvest`.

Rerunning with the required Linux dependencies installed allowed `fitzRoy` to install successfully.

### Seasons tested

Tested seasons: 2018, 2019, 2020, 2021, 2022, 2023, and 2024.

### Results

| Season | Result |
|---|---:|
| 2018 | 207 rows |
| 2019 | 207 rows |
| 2020 | 135 rows |
| 2021 | NULL |
| 2022 | NULL |
| 2023 | NULL |
| 2024 | NULL |

### Columns returned for working seasons

- `Date`
- `Venue`
- `Season`
- `Round`
- `Home.Team`
- `Away.Team`
- `Home.Score`
- `Away.Score`
- `Home.Margin`
- `Away.Margin`
- `Home.Win.Odds`
- `Away.Win.Odds`
- `Home.Win.Paid`
- `Away.Win.Paid`
- `Home.Line.Odds`
- `Away.Line.Odds`
- `Home.Line.Paid`
- `Away.Line.Paid`

### Key findings

- fitzRoy odds data is available for 2018–2020 in this check.
- It returned no data for 2021 onward.
- It includes H2H odds and line odds.
- It does not appear to include the actual handicap line value.
- It does not include totals odds.
- It does not include timestamps.
- It does not include bookmaker names.
- It is not suitable as a primary AFL odds source.

### Assessment

**Result:** ⚠️ Warn / supplementary only.

fitzRoy should not be used as the odds backbone for the AFL feasibility study. AusSportsBetting remains the primary historical odds source.

fitzRoy can still be used for fixtures, results, player stats, team stats, and lineups.

---

## 3. The Odds API AFL live endpoint

**Status:** Checked.

### Sports endpoint

`aussierules_afl` is active.

```json
{
  "key": "aussierules_afl",
  "group": "Aussie Rules",
  "title": "AFL",
  "description": "Aussie Football",
  "active": true,
  "has_outrights": false
}
```

---

```markdown
## Overall decision

**Result:** 🟢 Green.

The AFL feasibility study is viable.

Reasons:

- Historical AFL line/spread data is available via AusSportsBetting with near-complete post-2013 closing-line coverage.
- Historical totals data is available but has higher missingness.
- fitzRoy is not useful as an odds backbone, but remains useful for AFL fixtures/results/stats/lineups.
- The Odds API returns live AFL H2H, spreads, and totals across multiple AU bookmakers.

### Recommended next step

Proceed to a tightly scoped AFL line/spread feasibility study.

Do not start with totals, props, quarters, or complex ML.

Start with:

1. AFL line/spread only.
2. 2014–2019 and 2022–2024 development/backtest windows.
3. 2025 held-out test.
4. 2020 excluded.
5. 2021 sensitivity only.
6. Simple baselines first: market baseline, Elo/home advantage, recent form.
7. CLV measured in line points first, not percentage.