# GoalScout v2

**Football betting probability engine — Over 2.5 and Under 2.5 goals**

GoalScout identifies pre-match football betting opportunities in the O2.5 and U2.5 goals markets by estimating true match probabilities, comparing them against bookmaker prices, and surfacing edge.

---

## What It Does

For each shortlisted match, GoalScout:

1. **Makes a directional call** — Over 2.5 *or* Under 2.5. Never both. The direction with the stronger signal wins.
2. **Estimates probability** — P(O2.5) from weighted team and league stats. P(U2.5) = 1 − P(O2.5).
3. **Calculates fair odds** — 1 / probability, no margin applied.
4. **Measures edge** — how much the bookmaker price exceeds fair odds. Positive = potential value.
5. **Captures three price snapshots** — tip-time, pre-kickoff (30 mins before), and closing — to track price movement and measure CLV.
6. **Settles results** and tracks model performance independently for O2.5 and U2.5.

---

## Architecture

```
SoccerSTATS.com
  └─ FlareSolverr (Cloudflare bypass)
       └─ Match scraper

The-Odds-API (UK region)
  └─ League activity filter + Over/Under odds

Shortlist Engine
  └─ Directional scoring: O2.5 signals vs U2.5 signals
  └─ One direction per match, grade A+/A/B

Probability Engine
  └─ P(O2.5) from team/league stats
  └─ Fair odds + edge calculation

Three-Snapshot Odds Capture
  └─ tip_time → pre_kickoff (30min) → closing

Settlement Engine
  └─ Fetches results, records outcomes
  └─ Tracks hit rate, Brier score, edge, CLV

Express API + HTML Dashboard
  └─ Shortlist tab: directional matches with odds and edge
  └─ Performance tab: O2.5 and U2.5 independently
```

---

## Directional Scoring

Each match is scored in both directions. The higher score determines the recommendation.

### O2.5 Signals (high-scoring match)
| Signal | Points |
|---|---|
| Home O2.5% ≥ 75% | +3 |
| Home O2.5% ≥ 65% | +2 |
| Home O2.5% ≥ 55% | +1 |
| Away O2.5% ≥ 75% | +3 |
| Away O2.5% ≥ 65% | +2 |
| Away O2.5% ≥ 55% | +1 |
| Combined avg TG ≥ 6.0 | +2 |
| Combined avg TG ≥ 5.0 | +1 |
| League O2.5% ≥ 55% | +1 |
| League avg goals ≥ 3.0 | +1 |
| PPG mismatch | +1 |
| Home CS% ≥ 35% | −2 |
| Away CS% ≥ 35% | −2 |
| Home FTS% ≥ 35% | −2 |
| Away FTS% ≥ 35% | −2 |

### U2.5 Signals (low-scoring match)
| Signal | Points |
|---|---|
| Home CS% ≥ 40% | +2 |
| Home CS% ≥ 30% | +1 |
| Away CS% ≥ 40% | +2 |
| Away CS% ≥ 30% | +1 |
| Home FTS% ≥ 40% | +2 |
| Away FTS% ≥ 40% | +2 |
| Home O2.5% ≤ 40% | +1 |
| Away O2.5% ≤ 40% | +1 |
| Combined avg TG ≤ 2.2 | +2 |
| League O2.5% ≤ 45% | +1 |
| Home O2.5% ≥ 65% | −2 |
| Away O2.5% ≥ 65% | −2 |
| Combined TG ≥ 4.5 | −1 |

**Grade bands** (based on winning direction score):

| Grade | Score | Meaning |
|---|---|---|
| A+ | ≥ 10 | Very strong candidate |
| A | ≥ 7 | Strong candidate |
| B | ≥ 5 | Worth investigating |

---

## Probability Model

**P(Over 2.5)** — weighted average of:
- Home team O2.5% (weight 0.35)
- Away team O2.5% (weight 0.35)
- League O2.5% (weight 0.10)
- Combined TG signal (weight 0.20)

**P(Under 2.5)** = 1 − P(Over 2.5)

**Fair odds** = 1 / probability

**Edge** = (market odds / fair odds − 1) × 100%

This is the baseline model. Future versions will add xG-based Poisson modelling once the baseline is calibrated.

---

## Three-Snapshot Odds Capture

| Snapshot | Timing | Purpose |
|---|---|---|
| `tip_time` | When shortlisted (6h cycle) | Baseline — what you'd bet at immediately |
| `pre_kickoff` | 25–35 mins before kickoff | Post-lineup price — best actionable price |
| `closing` | As close to kickoff as possible | CLV reference |

Price movement from tip_time → pre_kickoff is tracked as a signal. Shortened odds = market agrees with your model. Drifted odds = lineup news changed things.

---

## Odds Source

**The-Odds-API, UK region** gives access to:
- Bet365
- Pinnacle (sharpest reference for true probability)
- William Hill
- Betfair Exchange
- Paddy Power, Coral, Ladbrokes, and others

UK region is used instead of AU because:
- AU region doesn't offer O2.5 totals for EPL
- UK region includes Pinnacle — best sharp reference book
- Dropping AU halves quota usage per API call

---

## Performance Tracking

The Performance tab tracks O2.5 and U2.5 **independently**:

- **Hit rate** — % of predictions correct
- **Mean model probability** — average confidence at tip-time
- **Brier score** — calibration quality (lower = better; 0.25 = coin flip)
- **Mean edge at tip** — average price advantage at shortlist time
- **Mean CLV** — how much tip-time price beat the closing line

Tracking separately matters because Over and Under models have different calibration characteristics and will need independent tuning.

---

## Data Storage

```
data/
├── shortlist.json              # Current shortlist (overwritten each cycle)
├── discovered-matches.json     # All bettable matches scored (overwritten)
├── meta.json                   # Refresh metadata
├── match-details/              # Per-match deep stats (overwritten)
└── history/                    # Append-only — never overwritten
    ├── predictions.jsonl       # One record per match: market = over_2.5 or under_2.5
    ├── results.jsonl           # Settled results
    └── closing-odds.jsonl      # All three snapshots: tip_time, pre_kickoff, closing
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Refresh state + metadata |
| GET | `/api/shortlist` | Shortlisted matches with direction, probability, edge |
| GET | `/api/matches` | All discovered bettable matches |
| GET | `/api/leagues` | All discovered leagues |
| GET | `/api/match/:id` | Match detail page data |
| GET | `/api/stats` | Performance stats — O2.5 and U2.5 independently |
| GET | `/api/predictions` | Raw prediction history (last 100) |
| POST | `/api/refresh` | Trigger manual refresh |
| POST | `/api/settle` | Trigger manual settlement + pre-kickoff odds capture |

---

## Setup

```bash
scp -r goalscout/ root@<unraid-ip>:/mnt/user/appdata/goalscout/
cd /mnt/user/appdata/goalscout
docker compose up -d
# Dashboard at http://<unraid-ip>:3030
```

### Deploy changes

```bash
cd /mnt/user/appdata/goalscout
docker compose down
docker rmi goalscout goalscout-goalscout 2>/dev/null || true
docker builder prune -f
docker compose up --build -d
docker logs -f goalscout
```

> Always use `docker compose up --build` — never `docker build` separately. Compose builds `goalscout-goalscout`; a separate build creates a different `goalscout` image that compose ignores.

---

## Roadmap

**Phase 1 — Current**
O2.5/U2.5 directional model, three-snapshot odds, clean calibration data, accurate results source.

**Phase 2 — Next**
xG from FBref, calibration pass at 200+ settled predictions, probability weight tuning per direction.

**Phase 3 — Future Modules**
BTTS as add-on module (needs xG layer first). Draw No Bet, Team Totals, First Half O/U built on the same core engine.

**Phase 4 — Automation**
Betfair Exchange integration, pre-match only (AU regulatory context).

---

## What This Is Not

- Not a tipster or tip-finder
- Not an in-play tool
- Not sentiment-based
- Not ML-driven yet — baseline must be validated first

The goal is trustworthy probabilities, clean calibration data, and measurable edge. Everything else follows from that.