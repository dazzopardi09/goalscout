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

**Status:** Not checked yet.

---

## 3. The Odds API AFL live endpoint

**Status:** Not checked yet.

---

## Overall decision

**Current status:** 🟡 In progress.

AusSportsBetting has passed the main historical odds check. Remaining checks:

1. fitzRoy odds inspection
2. The Odds API AFL live support for H2H, spreads, totals
