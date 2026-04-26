Absolutely. Here’s a clean **design handoff summary** you can paste into a new design chat or give to Claude.

I can also give you the two Lab screenshots from this chat, but I only have direct access to the screenshots uploaded here, not the earlier Claude Design screenshots unless you upload them again.

## Available screenshots from this chat

* [Lab page — top / equity curve screenshot](sandbox:/mnt/data/Screenshot%202026-04-25%20at%208.08.52%E2%80%AFpm.png)
* [Lab page — open positions / settled bets screenshot](sandbox:/mnt/data/Screenshot%202026-04-25%20at%208.08.59%E2%80%AFpm.png)

---

# GoalScout Design Handoff Summary

## Project context

We are designing the UI direction for **GoalScout v3**, a football betting-model research app focused initially on **Over/Under 2.5 goals markets**.

The app currently:

* runs locally on Unraid
* scrapes/scoring football fixtures
* overlays odds from The-Odds-API
* produces shortlists
* stores predictions/results locally
* tracks model performance, ROI, CLV, closing odds, and settlement results

The product should feel like a **serious model-evaluation and research dashboard**, not a flashy gambling app. Current project state is a local Docker app with SoccerSTATS, The-Odds-API, Express API, JSON storage, and future plans around xG, value detection, Betfair, and automated betting/research workflows. 

The design direction we chose is:

```text
dark terminal / trading-desk / probability-engine aesthetic
```

It should feel technical, sharp, compact, data-heavy, and credible.

---

# Pages designed so far

## 1. Shortlist page

### Purpose

The Shortlist page is the main “what should I look at today?” screen.

It shows upcoming matches that the model has flagged as interesting.

### Intended role

```text
Shortlist = today’s model signals
```

### Key design direction

* Dark UI
* Compact top status bar
* GoalScout branding
* Tabs for:

  * Shortlist
  * Performance
  * Lab
* Cards or rows for shortlisted fixtures
* Strong emphasis on:

  * match
  * kickoff
  * league
  * model probability
  * market odds
  * fair odds
  * edge
  * confidence/signal strength
  * model type, e.g. current vs calibrated

### Notes

The actual copy in the mockup should not be treated as final. It was placeholder/design text only.

Important future consideration:

* allow the header to shrink/stick on scroll
* do not over-polish static text yet
* the design should support live data and responsive layout later

---

## 2. Match details / lineup impact direction

### Purpose

This area is intended for future deeper match-level analysis.

### Desired future modules

* model breakdown
* recent form
* league scoring profile
* odds movement
* squad/news context
* lineup impact
* injury impact
* player-level context

### Important design note

For lineup impact, we probably want **player photos** eventually.

There are likely football APIs that provide player images, but this is a future enhancement. The current design just needs to leave room for that sort of visual module.

---

## 3. Performance page

### Purpose

The Performance page answers:

```text
Is the model actually working?
```

This should not just be a “nice stats page”. It needs to help evaluate whether the model is producing reliable, profitable, calibrated signals.

### Intended role

```text
Performance = model truth-checking
```

### Key metrics to show

* ROI
* profit/loss in units
* settled bets
* hit rate
* Brier score
* CLV
* average CLV
* closing odds movement
* pre-kickoff odds vs close
* current model vs calibrated model
* market segmentation
* league segmentation eventually
* bet type segmentation eventually

### Missing/tweak noted

The current Performance page mockup seemed to be missing an obvious button/control to swap between models.

We want clear controls for:

```text
Model: Current / Calibrated
Market: O2.5 / U2.5 / BTTS future
Window: 7D / 30D / Season / All
```

### Design requirement

Performance should be compact and analytical, not marketing-style.

The user should be able to quickly see whether:

* the model is profitable
* the model is calibrated
* CLV is positive or negative
* results are coming from genuine signal or variance
* specific markets/leagues are underperforming

---

## 4. Lab / simulated portfolio page

### Purpose

The Lab page is a future paper-trading / simulated-betting module.

It should simulate disciplined staking strategies against historical/live model signals.

No real bets are placed.

### Intended role

```text
Lab = strategy simulation / model portfolio testing
```

### Current design title

```text
Lab · paper trading
```

### Preferred possible rename

Better labels may be:

```text
Lab · simulated portfolio
```

or:

```text
Lab · simulated trading
```

My preferred option:

```text
Lab · simulated portfolio
```

It sounds less like gambling and more like model validation.

---

# Lab page design details

## Top safety/research framing

The page includes a prominent disclaimer:

```text
Simulated bankroll only — no money is wagered.
The lab compares strategies and models against historical lines.
```

This is exactly the right direction.

The page should make clear:

* no bookmaker integration
* no real money wagered
* research-only module
* simulated P/L only
* not betting advice

This is important both for product positioning and compliance tone.

---

## Strategy comparison

The Lab page compares staking strategies:

```text
Flat 1u
Fixed 2%
Kelly ¼
```

This is a strong setup.

### Why this matters

Flat staking shows whether the model itself has an edge.

Fixed percentage shows bankroll-compounding behaviour.

Kelly ¼ shows model-aggressive staking, but with risk control.

Full Kelly should not be used at this stage because the sample size is too small and the probability model is still noisy.

### Good current metrics

Each strategy card shows:

* ROI
* P/L
* max drawdown
* hit rate
* mean CLV
* stake standard deviation

This is useful and should be retained.

---

## Equity curve + drawdown

This is one of the strongest parts of the Lab design.

The page shows:

* bankroll/equity curve
* starting bankroll line
* ending bankroll
* current drawdown
* drawdown strip underneath

This should stay.

### Why it matters

Raw ROI can mislead. The curve tells us:

* whether gains were steady or lucky
* whether the drawdown is survivable
* whether the model recovers
* whether staking rules are too aggressive
* how volatile the strategy feels

---

## Model × market matrix

The Lab page includes a model/market comparison table:

```text
Current      | Over/Under 2.5 | BTTS | xG Markets | Asian Handicap
Calibrated   | Over/Under 2.5 | BTTS | xG Markets | Asian Handicap
```

Current live market:

```text
Over/Under 2.5
```

Future modules:

```text
BTTS
xG markets
Asian handicap
```

This is a good future-facing section because it shows where GoalScout could expand without making the current app feel incomplete.

---

## Open positions

The page includes simulated open positions.

Good columns:

```text
KO
Match
Direction
Stake
Odds
Fair
Model
Edge
CLV-watch
```

This works well.

It makes the Lab page feel like a simulated portfolio, not just a historical report.

Important: these must be clearly simulated entries, not real bets.

---

## Settled paper bets

The bottom table shows recent simulated settled bets.

Good columns:

```text
Date
Match
Direction
Stake
Odds
Score
P/L
```

This is useful for auditability.

When implemented, this should pull from actual prediction/result records rather than inventing separate mock paper-bet data.

---

# Important implementation caveat

The mockup data is not real.

For example, the mockup included:

```text
Newcastle Jets vs Central Coast
Score: 4-1
Odds: 1.79
```

But the actual first live settled GoalScout result was:

```text
Newcastle Jets vs Central Coast
Score: 4-0
Pre-kickoff odds: 1.29
Closing odds: 1.33
CLV: -3.01%
Status: settled_won
Result source: odds-api
```

So when building this page, do **not** create a separate fictional paper-trading dataset unless explicitly intended.

The Lab should ideally derive from:

```text
predictions.jsonl
results/settlement fields
closing odds
pre-kickoff odds
model probability
fair odds
edge
market
method/current/calibrated
```

---

# Recommended future design tweaks

## 1. Add clearer global controls

Across Performance and Lab, we need clear controls for:

```text
Model: Current / Calibrated
Market: O2.5 / U2.5 / BTTS future
Window: 7D / 30D / Season / All
Strategy: Flat / Fixed / Kelly
```

These do not all need to be functional immediately, but the layout should support them.

---

## 2. Add sample-size warnings

When the sample is small, show something like:

```text
47 settled · early signal only
```

or:

```text
Low sample size — treat as directional only
```

This matters because ROI over 40–50 bets can be very noisy.

---

## 3. Add result-source audit

Very useful for settlement reliability:

```text
Verified: 18
Odds API only: 29
Manual/fallback: 0
```

This matters because some leagues can be cross-verified with Football-Data, while others, like Australia, may only settle from Odds API.

---

## 4. Add CLV distribution later

Mean CLV is useful but not enough.

Future stats:

```text
CLV+
CLV-
Avg CLV
Median CLV
Best CLV
Worst CLV
% beating close
```

This helps show whether CLV is broadly positive or just skewed by a few big movers.

---

## 5. Keep the design compact

The aesthetic works because it feels dense, sharp, and analytical.

Avoid:

* large empty marketing cards
* casino styling
* generic SaaS dashboard look
* overuse of gradients
* big rounded bubbly UI
* motivational betting language

Prefer:

* compact rows
* small uppercase labels
* restrained colour
* clear numbers
* audit trails
* understated warnings

---

# Overall product structure

The three major pages should map to clear mental models:

```text
Shortlist   = what looks interesting today
Performance = whether the model is working
Lab         = how strategies behave under simulation
```

That structure is strong and should remain.

---

# Suggested prompt for a new design chat

You can paste this:

```text
We are continuing the UI design for GoalScout v3.

GoalScout is a football betting-model research dashboard focused initially on Over/Under 2.5 goals markets. It runs locally, stores predictions/results, tracks closing odds, CLV, ROI, hit rate, Brier score, and settlement outcomes.

The design direction is dark, compact, analytical, terminal/trading-desk style. It should feel like a probability engine and model-evaluation tool, not a flashy gambling app.

Pages designed so far:
1. Shortlist — today’s model signals
2. Performance — model truth-checking, ROI, CLV, hit rate, Brier score, model comparison
3. Lab — simulated portfolio / paper trading module for strategy testing

Important design principles:
- research-first, not betting-advice tone
- simulated bankroll clearly labelled as simulated
- no bookmaker integration implied for Lab
- compact data-dense layout
- strong auditability
- support Current vs Calibrated model switching
- support future markets: BTTS, xG markets, Asian handicap
- show sample-size warnings when settled bet count is low
- include result-source audit eventually: verified / odds-api / manual fallback
- keep dark terminal/trading aesthetic

For the Lab page, we liked:
- strategy comparison: Flat 1u, Fixed 2%, Kelly ¼
- bankroll/equity curve
- drawdown chart
- open simulated positions
- settled paper bets
- model × market matrix
- clear research-only disclaimer

Next design task:
Create responsive versions across Shortlist, Performance, and Lab.
Prioritise mobile/tablet behaviour, sticky/shrinking headers, readable tables, and sensible collapsing of dense data.
```

---

## My recommendation

Since design credits reset Monday, I’d use the next design session for:

```text
Responsive design across Shortlist, Performance, and Lab
```

Not another new desktop page yet. The desktop direction is strong enough.
