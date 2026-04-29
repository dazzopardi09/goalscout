# GoalScout — Strategy & Direction Review (v2)

**Date:** 29 April 2026
**Version:** v2 — citation corrections applied 29 April 2026
**Status:** Research / strategy piece. No code, no patches, no automation recommendations.
**Scope:** Where to take GoalScout next, given disappointing O/U 2.5 results.

> **Citation correction note (v2):** The original v1 of this memo incorrectly attributed the O/U 2.5 academic benchmark to "Goddard & Asimakopoulos (2004)" and described the odds condition as "Pinnacle's tight odds" and the model as "shots + corners." All three were wrong. The correct citation is Wheatcroft (2020), the odds condition is BetBrain best-available across all bookmakers, and the model is GAP ratings (a dynamic attacking-performance rating system) using shots/corners as inputs with a value-betting selection rule. Two further caveats have been added: (a) best-available historical odds are not the same as practically bettable live odds; (b) the claim that average odds eliminates the profit is directionally supported in the paper but was not verified at the specific table level in preparing this memo. The strategic conclusions are unchanged.

---

## A. Executive summary

**Honest read of where you are:** Your O/U 2.5 model is not broken. A 58–60% hit rate combined with no edge over a no-vig market baseline is a plausible result for a season-aggregate goals model competing in a major liquid market. The closest academic study on this problem — Wheatcroft (2020), "A profitable model for predicting the over/under market in football," *International Journal of Forecasting*, **36**(3), 916–932, DOI: 10.1016/j.ijforecast.2019.11.001 — found ~0.8% average profit per bet over 12 years across 10 European leagues, but only when assuming best-available odds across all bookmakers via the BetBrain odds aggregator. The model was not raw shots and corners but *GAP ratings* — a dynamic attacking-performance rating system updated after each match — with shots/corners as the rating inputs, combined with a value-betting rule that only selects bets where forecast probability exceeds the bookmaker's implied probability. Two important caveats apply to that headline figure: first, best-available historical odds are not the same as practically bettable live odds — in practice you will not consistently get the BetBrain maximum at the stakes GoalScout targets, so the real-world achievable margin is thinner than the paper implies; second, whether average-odds betting eliminates the profit entirely is directionally supported in the paper but was not verified at the specific table level in preparing this memo. With those caveats, the qualitative pattern — that goals are the worst input and non-goal attacking stats outperform them, and that the edge is razor-thin and margin-sensitive — is consistent with your results. That's a well-calibrated finding, not a failure of your modelling.

**The single most important reframing:** SoccerSTATS season aggregates (O2.5%, avgTG, CS%, FTS%) are exactly the features the market is best at pricing. They are public, slow-moving, and trivially available to every operator. Trying to find edge with them in major-league O/U 2.5 is structurally hard for any individual modeller. This is a feature-set problem, not a model problem.

**The one-line recommendation:** Stop adding new market variants on top of the same data. Spend the next 4–8 weeks on **two parallel tracks** that compound:

1. **Infrastructure:** Build the dataset and odds-capture pipeline GoalScout needs to do *any* of the next steps properly — opening odds, closing odds, prediction logs with full feature snapshots, settled results, and CLV per pick. This is foundational and unlocks every option below.
2. **AFL feasibility study:** Two to three weekends of analysis using the free `fitzRoy` R package and `Squiggle` API to test whether AFL line/total markets show the kind of behavioural inefficiency that historical academic work suggests they have. Decide go/no-go after that, not before.

**Direct answers to your A-questions:**
- *Should we keep going with soccer?* Yes, but **only as a hybrid market-prior + features model**, not the current SoccerSTATS-base approach. And only after the data infrastructure is in place.
- *Should we pivot market within soccer?* BTTS is a trap — it shares ~80% of the signal and the same data, so the same efficiency argument applies. Cards and corners are genuinely softer markets but require referee data and a heavier rebuild.
- *Should we pivot to AFL?* **Run a feasibility study before committing.** AFL has unusually good free data, smaller crowd, and Australian regulatory tailwinds for you specifically. But ~207 regular-season games per year is a thin sample, and the line-betting markets have professionalised since the older academic studies.
- *Should we focus on dataset/ML infrastructure first?* **Yes, in parallel with the AFL study.** Without it, every other option you ranked is bottlenecked.
- *What is the most rational next move?* Track 1 (infrastructure) + Track 2 (AFL feasibility study) running side by side for ~6 weeks. Reconvene to decide direction with concrete data in hand.

The rest of this document expands the reasoning, ranks options, addresses your section 6 base-model question in depth, and is blunt about what to stop doing.

---

## A2. The honest read on your O/U 2.5 results

Before ranking options, you need to internalise what your historical tests actually demonstrated. This matters because the wrong takeaway leads to the wrong pivot.

**What your tests showed:**
- A 58–60% hit rate at the directions your model picked.
- No edge over no-vig market-implied probability.
- Negative ROI at broad historical bookmaker prices.
- A possibly-interesting Scotland O2.5 segment, not yet live-validated.

**What this means in plain English:**
The market's no-vig probability is roughly as good as your model. You are paying the bookmaker's margin (typically 4–8% on O/U 2.5 across mainstream books, lower at Pinnacle and the exchanges) to bet a probability the market already knew. That's not a model that finds nothing — it's a model that finds about the same thing the market did.

**Why this is an unsurprising result:**
- Major-league soccer O/U 2.5 is one of the most-traded markets globally, with Asian books reportedly handling >70% of football turnover (Constantinou & Fenton, 2020). Anything that can be inferred from publicly available *season aggregates* is likely to be well priced.
- The features you used — O2.5%, avgTG, clean sheet rate, failed-to-score rate — are exactly the simple descriptive statistics every odds-setter has had access to for decades.
- Wheatcroft (2020), the closest academic benchmark for O/U 2.5 goal-totals modelling, found that GAP ratings using shots and corners as inputs produced ~0.8% per bet over 12 years — but only at best-available BetBrain odds across all bookmakers, a condition most individual bettors cannot reliably replicate live. Critically, goals as the GAP rating input were *loss-making* in all leagues tested, while shots and corners outperformed them. The paper's discussion implies that average-odds betting degrades or eliminates the profit, though the precise per-table figure was not verified at the table level in preparing this memo. What can be said with confidence: your feature set (season-aggregate goals-based stats) at average market prices is exactly the scenario the paper's evidence suggests would underperform. Your result is consistent with this pattern.

**What is *not* shown by your tests:**
- That goal-quality features (xG, big chances, shots-on-target) can't add edge on top of the market — your tests didn't include them as the *base*.
- That market-relative modelling (treating the no-vig probability as a prior and predicting the residual) doesn't work — you haven't really tried it as the architecture.
- That AFL or other markets are equally efficient.
- That CLV-tracking would not surface filters that work.

The right conclusion is **not** "soccer modelling is dead." It's "the SoccerSTATS-aggregate base is a dead end at the major-league level." Those are different problems with different solutions.

---

## B. Ranked options for the next direction

Each option is assessed on a consistent rubric and ordered by what's most rational given your current state, your roadmap, and the weight of available evidence.

### 1. Build the data and CLV infrastructure layer (do this regardless)

**Why it might work:** Every other serious option below requires it. You currently log predictions but you don't have the odds-snapshot or CLV machinery to *measure* whether any new model is actually beating the market. Without that, you'll be in the same position six months from now: a backtest that says "negative ROI at broad odds, positive at narrow ones" with no way to determine which side reality is on for *your* live picks.

**Why it might fail:** It's not a betting strategy itself. If you treat it as a destination rather than a foundation, you'll have built a sophisticated tracker for an empty model.

**Data needed:** Opening odds (within ~5 min of market open), closing odds (within ~1–2 min of kickoff), full feature snapshot at prediction time, settled results, model probability per pick.

**Cost / complexity:** Moderate. The Odds API + your existing Football-Data.org settlement pipeline cover most of it. The hard part is **closing-line capture** — you need a near-kickoff snapshot, not a 30-min-pre snapshot. This is mostly a scheduler problem.

**Expected edge potential:** Indirect. CLV gives you a real-time leading indicator of expected long-term ROI, so you can stop running models for months on end before discovering they don't beat the close.

**Backtest feasibility:** N/A — it's measurement, not prediction.

**Live validation path:** Track CLV per shortlist live, in parallel with current ROI tracking. After ~300–500 settled bets you'll have a stable signal.

**Recommendation:** **Top priority. Start now. Do this even if you ultimately pivot to AFL** — the same architecture serves AFL.

---

### 2. AFL feasibility study (2–3 week timeboxed research project)

**Why it might work:**
- Free, structured, well-maintained data via the `fitzRoy` R package, which scrapes AFL Tables, Footywire, and The Squiggle API. Historical results, lineups, player stats, and even historical bookmaker odds (`fetch_betting_odds_footywire`) are all in one place.
- Squiggle aggregates predictions from multiple public AFL models — useful as a sanity check and as an input feature.
- Smaller, more domestic crowd: less global sharp money compared to EPL totals. Older academic work (Brailsford, Easton, Gray & Gray, 1995) found probit models could generate significant profits in the AFL Footywin market historically. The market has professionalised since, but a smaller, regional bettor pool typically means slower price correction.
- You're in Australia. Pre-match-only is the legal baseline, which suits GoalScout's roadmap perfectly.
- Timing: AFL season just started, soccer winding down. You'd be testing in-season immediately.

**Why it might fail:**
- ~207 regular-season AFL games per year, plus finals. That's roughly 1/4 of a single mid-tier soccer league season's volume. Statistical noise is significant — you need multiple seasons of historical data plus paper trading before any conclusion.
- Australian bookmakers (Bet365, Sportsbet, Ladbrokes, TAB) all heavily restrict winning customers. Even if you find edge, *executing* it at scale is constrained. Betfair Australia Exchange is small relative to UK Betfair, with thinner liquidity on AFL totals.
- The line/spread market is the dominant AFL betting line in Australia, not totals — but spread modelling is mathematically more tractable than goal-totals modelling because score distributions are much smoother (AFL games typically score 60–120 points, soccer 0–6).
- Public-bias edges (overpricing of marquee teams like Collingwood, Geelong) probably exist but are smaller than they were a decade ago.

**Data needed for the feasibility study itself:** Last 5+ AFL seasons of fixtures, results, lineups, betting odds (head-to-head, line, total). All available via `fitzRoy`. No API costs.

**Cost / complexity:** Low for the study. Two to three weekends of work to build a basic Elo + recent-form model, compare it to closing odds, measure CLV. You're not building production AFL GoalScout yet — you're answering "is there a there here?"

**Expected edge potential:** Genuinely uncertain in a way soccer O/U 2.5 isn't. Worth investigating precisely because the answer isn't already obvious.

**Backtest feasibility:** Excellent. `fitzRoy` historical odds + result data go back well over a decade.

**Live validation path:** AFL season is in progress. After the feasibility study, paper-trade a defined model for the rest of 2026 and decide on real production for 2027.

**Recommendation:** **Run this study now in parallel with infrastructure work.** Cap it at 3 weekends. Decide on the basis of real numbers, not enthusiasm or scepticism.

---

### 3. Hybrid model: market-implied prior + xG/form residuals (soccer)

**Why it might work:** This is the architecture most serious practitioners and researchers land on, and the one you have *not* yet tried as your base. Concept: take the no-vig market O/U 2.5 probability as your starting point. Treat your features (xG, recent form, shots) as predictors of *the residual* — i.e., what does the market miss? A 2024 comparative study of xG models on 11 Bundesliga seasons (researchgate, "Comparative Analysis of Expected Goals Models") found that simple xG-Skellam models with isotonic calibration produced ROI ~10% on average odds, ~15% at best available — but only on specific bet types (home wins). That's one paper, on one league, on a different market. Treat it as suggestive rather than conclusive, but it's evidence that xG may carry signal the market doesn't fully price in all contexts.

**Why it might fail:**
- Your current data layer doesn't have rolling xG. The natural source is Understat (still functional, free, six leagues from 2014/15 onward). FBref's advanced data was terminated in January 2026, so anything you might have planned around FBref Opta-derived xG is gone.
- The home-win finding doesn't directly translate to O/U 2.5. xG signal in totals markets is empirically weaker than in 1X2 outcomes.
- "Predict the residual" sounds elegant but in practice you need to be very careful that your residual model isn't just rediscovering the prior. Calibration is hard.

**Data needed:**
- Understat xG/xGA history for matched leagues
- Bookmaker no-vig probability at prediction time and at close
- Rolling 5–10 game xG for/against per team
- Match-level shot data (volume, on-target, big chances)

**Cost / complexity:** Medium-high. Understat scraping is well-supported (`understatapi`, `worldfootballR`, `soccerdata`) but adds a real ingestion layer you don't currently have. Calibration (Platt or isotonic regression) needs proper out-of-sample validation.

**Expected edge potential:** Plausibly modest. The evidence points toward real but small and league-specific positive expectancy with this approach; don't expect a clean generalisation across all leagues.

**Backtest feasibility:** Strong. Understat data + Football-Data.co.uk historical odds covers ~10 seasons of Big-5 leagues. Open the 2014/15–2023/24 range as a development set, hold out 2024/25–2025/26 as test.

**Live validation path:** Run alongside current model after backtest passes. Demand 200+ live picks before judging.

**Recommendation:** **The right base-model rebuild for soccer if you stay with soccer.** Higher priority than continuing to tune SoccerSTATS variants. Lower priority than infrastructure and the AFL study because it depends on infrastructure being in place.

---

### 4. CLV-prediction modelling (predict line movement, not result)

**Why it might work:** A CLV-prediction target sidesteps the hardest bit of result-prediction modelling: you no longer need to be right about the goals; you only need to be right about whether the price will drift in your favour. Liquid markets converge to "true" probability at close, so a model that predicts pre-close-to-close movement is essentially a model that predicts which features the market underweights early. This is also more sample-efficient — every market has a closing line, regardless of whether the bet wins or loses.

**Why it might fail:**
- Bookmakers move lines for many reasons: sharp action, public action, injury news, weather, lineups. Disentangling these without exchange order-flow data is hard.
- You don't have opening-odds data captured systematically yet (this is what option 1 fixes).
- Predicting line movement well doesn't automatically translate into bettable edge if the move is happening because of news that arrives after you place. You need to be early *and* directionally correct.
- Many books in Australia restrict winners aggressively. Even if you predict closing-line movement well, you may not be able to act on it at scale.

**Data needed:** Opening odds, multiple intermediate snapshots, closing odds, your features, market-impact features (time-to-kickoff, recent line moves), and ideally injury/lineup news timing.

**Cost / complexity:** High. You need infrastructure (option 1), you need at least one off-the-shelf news/lineup signal source, and you need a careful train/test split that doesn't leak future information.

**Expected edge potential:** Real but bounded. CLV is the single best leading indicator of long-term betting profitability across the sports betting literature. But predicting CLV is harder than measuring it.

**Backtest feasibility:** Possible but data-hungry. The Odds API gives you snapshots, but historical opening-line capture for past seasons is limited.

**Live validation path:** Forward-test only. CLV target is computable per pick within ~24 hours of kickoff.

**Recommendation:** **Don't do this yet.** The infrastructure (option 1) is a prerequisite. Once that's in place for 3–6 months, revisit.

---

### 5. Scotland O/U 2.5 live-validation watchlist

**Why it might work:** You found a historically interesting Scotland O/U 2.5 segment. Smaller leagues are documented in the academic literature (e.g., Reading EMDP series) to be measurably *less* efficient than top-tier leagues — lower volume, fewer informed bettors. Scotland is an underbet, parochial market. If your historical signal is real, Scotland is exactly the kind of league where it should persist.

**Why it might fail:**
- A single-league historical edge is the most over-fit thing in betting research. Scottish football has ~480 league fixtures per year across the Premiership and Championship. Two or three seasons is a small sample.
- You may have found the one league where your existing feature set happens to align with how those particular teams play, not a generalisable inefficiency.
- Bookmaker margins on Scottish football are typically wider than EPL, eating away at any edge.
- Liquidity is thin. Even Bet365 line maxes on Scottish lower-division O/U 2.5 are small. Sportsbet and Betfair Australia coverage is patchy.

**Data needed:** What you already have, plus ideally a richer recent-form/xG layer for Scottish football (Understat does NOT cover Scotland — this is a real gap).

**Cost / complexity:** Low for paper-trading. Higher for any feature enrichment (Scottish xG sources are not free).

**Expected edge potential:** Worth investigating, but small in absolute terms.

**Backtest feasibility:** Already done; the historical signal is what raised it.

**Live validation path:** Define the rule strictly (which thresholds, which leagues, which markets), paper-trade for one full Scottish season, judge with CLV plus ROI plus standard error.

**Recommendation:** **Run as a small-effort secondary track.** Maintain a Scotland watchlist, log paper bets, check CLV. Don't scale until you have a full season of forward-tested evidence.

---

### 6. Lower-league / niche-league focus more broadly

**Why it might work:** Multiple academic and practitioner sources point toward lower-tier and "less-watched" league markets being less efficient than EPL/La Liga/Bundesliga. The Reading EMDP analysis explicitly noted "competition in the online market is less, the volume of money staked is lower" in the lower English tiers. League Two has measurably more model-vs-market discrepancy than the Premier League.

**Why it might fail:**
- Data quality drops with league tier. xG coverage is virtually nonexistent below Big-5 + Championship in the free ecosystem.
- Bookmaker margins are *wider* on lower leagues, which can offset any inefficiency.
- Liquidity on totals lines is thin. You'll struggle to bet meaningful stakes.
- Your current SoccerSTATS-aggregate base would be re-applied to leagues where the descriptive stats are even noisier (smaller squads, more turnover, more weather-affected pitches).

**Data needed:** Lower-league results data (Football-Data.co.uk covers EFL well; Understat does not extend below the Big 5).

**Cost / complexity:** Low for English League One/Two. Moderate for non-English lower tiers.

**Expected edge potential:** Real but capped by margin and liquidity.

**Backtest feasibility:** Reasonable for EFL, weaker for non-Big-5 lower leagues.

**Live validation path:** Same workflow as Scotland watchlist.

**Recommendation:** **Combine with #5.** A "low-volume, narrow scope" strategy across Scotland + League One + League Two + Eredivisie. Worth keeping live as a low-effort track alongside the bigger pivots.

---

### 7. Cards / corners markets

**Why it might work:** Both markets are less liquid and less heavily modelled than goals. Referee tendencies are a documented driver of card markets specifically — strong and individually identifiable. The corner market has well-understood structural drivers (wide play, possession territory, set-piece threat) that aren't captured by goals-based stats. Practitioner literature frequently rates these as the best places to find edge in soccer for hobbyist bettors.

**Why it might fail:**
- Data infrastructure is an entirely separate build. Referee assignments, recent referee tendencies, team-level corners-for/against rolling stats, and reliable in-running corner counts all need new pipelines.
- Card and corner totals are correlated with match state and game flow in ways goal markets aren't. A red card mid-match changes everything; you can't easily model that pre-kickoff.
- Margins on corners/cards markets are typically *wider* than on O/U 2.5 — sometimes 8–12% overround. The inefficiency has to be larger than that just to break even.
- The "edge in less-watched markets" anecdotes mostly come from people who specialise in those markets full-time. They'll have referee databases, line-up timing, in-running data feeds. You'd be entering a niche that's softer in absolute pricing but harder to compete in than people make out.

**Data needed:** Referee histories, team corner-for/against, fixture-level referee assignment (often available 24–48 hours before kickoff only), set-piece quality stats.

**Cost / complexity:** High. This is a fundamental rebuild, not a layer.

**Expected edge potential:** Real if you specialise. Mid-pack if you dabble.

**Backtest feasibility:** Possible via `oddalerts`-style scraped corner data, FlareSolverr-style scraping of football statistics aggregators. Patchy historically.

**Live validation path:** Long. You're effectively starting a new project.

**Recommendation:** **Park it.** Worth a follow-up project after the AFL question is resolved. Not the right next step.

---

### 8. Asian Handicap & Asian totals as base markets

**Why it might work:** AH markets are where the global money is. Pinnacle and Betfair Exchange both quote AH and Asian totals with very tight margins (sometimes <2% overround). Lower margin = lower bar to clear for any signal-based edge. Quarter-line splitting (e.g., -0.25, +0.75) provides finer pricing granularity, which can surface mispricing your current discrete-line model misses.

**Why it might fail:**
- Tight margins mean tight prices — these are the *most efficient* football markets globally. Mispricing on AH at Pinnacle is rare and small.
- Constantinou & Fenton (2020) explicitly investigated AH efficiency with a Bayesian network model and pi-ratings; the finding was that profitable strategies existed only at maximum (not average) market odds — a pattern consistent with other efficiency research on top-league football.
- Your current bookmaker stack (Betfair, Bet365, Sportsbet) is fine for AH but you'll only be competitive at the exchange.
- Splitting half-stakes and quarter-line settlement adds complexity to the bookkeeping pipeline.

**Data needed:** Same as soccer base, plus Asian-formatted historical odds (Football-Data.co.uk includes Pinnacle AH for major leagues).

**Cost / complexity:** Medium. The market structure changes how you define edge.

**Expected edge potential:** Marginal at best.

**Backtest feasibility:** Reasonable.

**Live validation path:** Standard.

**Recommendation:** **Lower priority.** Don't pivot to AH expecting it to be easier than O/U 2.5. The reverse is closer to true at top leagues. AH on lower/niche leagues — see option 6.

---

### 9. Lineup / injury / team-news adjustment layer

**Why it might work:** Practitioner consensus flags late team news as one of the most consistently profitable edges in soccer betting — striker rules out 90 min before kickoff, key keeper benched, etc. These shifts are real and often underpriced in the immediate aftermath.

**Why it might fail:**
- Timing is brutal. Lineups are confirmed ~60 minutes before kickoff. You have a narrow window to detect, model, and act.
- Bookmakers respond fast — exchanges respond in seconds, books respond in minutes. By the time you've programmatically detected an XI and re-priced, the market has too.
- Pre-match-only is your operational model (legal/regulatory). Sophisticated lineup-based betting often blurs into in-running.
- Data sources for confirmed lineups in real-time are limited at the free tier (BBC, Sky Sports, official club channels — all manual). Paid feeds exist (API-Football, Sportmonks).

**Data needed:** Real-time confirmed-lineup feed, player-level impact ratings (xG/xGA contribution per player), injury news source.

**Cost / complexity:** Very high for a competitive offering. Moderate for "alert me when a key player is dropped" simple version.

**Expected edge potential:** Real but operationally narrow.

**Backtest feasibility:** Limited. Historical lineup confirmation timing is hard to reconstruct.

**Live validation path:** Difficult.

**Recommendation:** **Park.** Not before you have infrastructure and a base-model rebuild. Possibly relevant much later.

---

### 10. BTTS pivot

**Why it might work:** Different market = potentially different efficiency profile. BTTS is popular with recreational bettors and frequently flagged as a "sentiment-driven" market.

**Why it might fail:** This is the option I most want to talk you out of. BTTS and O/U 2.5 are highly correlated outcomes — they're both functions of the same underlying joint goal distribution. Any data that informs O/U 2.5 informs BTTS, and your existing features (avgTG, CS%, FTS%) literally *are* what BTTS is. Switching markets without switching the data layer is changing the colour of the seat covers, not fixing the engine. The literature is clear: bookmakers occasionally offer combined BTTS+O/U lines, which "may not reflect the true independent probability" — i.e., the markets are deeply linked. Furthermore, BTTS has wider overround at most books than O/U 2.5 (typically 7–10% vs. 4–6%), so the bar to find edge is higher.

**Data needed:** Same as current.

**Cost / complexity:** Low.

**Expected edge potential:** Same or worse than O/U 2.5. **Don't expect a different result.**

**Backtest feasibility:** Yes.

**Live validation path:** Yes.

**Recommendation:** **Skip.** If you want to trial it, do it as an output of the same model rather than a pivot.

---

## C. Market softness research — which markets are likely softer than O/U 2.5

The honest answer is: **softer in pricing isn't the same as softer in edge potential.** Margin matters as much as efficiency. Here's the calibrated view, ordered roughly best-to-worst for individual modellers:

**Softer than O/U 2.5 — both in pricing and in edge potential:**

- **AFL totals/lines (Australia) — for individual modellers** — Smaller bettor crowd, free data, regulatory regime suits pre-match. The biggest unknown. Worth the feasibility study.
- **Lower-tier league O/U lines (League One, League Two, Scottish Championship/League One, lower Eredivisie/Brasileirão tiers)** — Less informed money, but wider margins offset. Plausibly better edge potential than EPL/La Liga; worse data quality.
- **Cards markets in mid-tier leagues with referee data** — Plausibly soft, but data infrastructure is the bottleneck. Weeks of work to build the layer before you can even backtest.

**Softer in some sense but a trap:**

- **Corners markets** — Margins typically too wide to overcome the soft-pricing advantage. Worth some study but not as a pivot.
- **Asian Handicaps and Asian totals at top leagues** — Margins very tight (good) but markets *more* efficient than EPL straight 1X2 (bad). Pinnacle's AH closing lines in the EPL are among the sharpest football prices in the world.
- **Lower-league BTTS** — Smaller volume, but BTTS overround is typically 8–10% even at sharp books. Hard to break.
- **Player props (anytime scorer, total shots, total fouls)** — Softer than markets but limit-restricted at every Australian book. You'll be capped to small stakes long before you scale.

**Not softer:**

- **EPL/La Liga/Bundesliga main markets** — Most efficient football betting markets in the world.
- **BTTS top leagues** — Tightly linked to O/U 2.5, similar efficiency, wider margin.
- **Top-league correct-score markets** — Wide margin, deep liquidity, sophisticated modellers everywhere.

**The structural rule:** Markets are softer where (a) bettor sophistication is lower, (b) liquidity is lower, (c) the market has less time to settle on a price, and/or (d) the result depends on factors that aren't well captured by public stats. Cards and AFL hit (a) and (d). Lower leagues hit (a) and (b). Live betting hits (c). Top-league O/U 2.5 hits none of them.

---

## D. Data-source research

### Soccer

| Source | What it gives | Cost | Reliability | Risk / caveat |
|---|---|---|---|---|
| **Football-Data.co.uk** | Historical results + opening/closing odds for ~30 leagues | Free | High; weekly updates | The single most important free historical odds source. Already in your roadmap. Lower-league coverage is excellent. |
| **The Odds API** | Live + historical pre-match odds across many books | Free tier (limited) → paid | High | You're already using it. Ample for major leagues, thinner on niche. |
| **Football-Data.org** | Fixtures, results, lineups, squads | Free tier → paid | High | You already use it for settlement. Good fallback. |
| **Understat** | xG, xA, xGChain, xGBuildup, shot-level data | Free | Medium-high | **Currently the leading free xG source.** Only covers EPL, La Liga, Serie A, Bundesliga, Ligue 1, Russian Premier League. From 2014/15. Python libs (`understatapi`, `understat`, `soccerdata`, `worldfootballR`). Light scraping tolerated; do not abuse. |
| **FBref** | ~~xG, xA, advanced metrics~~ + basic historical data for 100+ comps | Free | **Severely degraded** | **Sports Reference lost their advanced data feed in January 2026.** xG, progressive passes, pressing intensity etc. were deleted from FBref on the data provider's demand. Basic historical results and tables remain. Plan accordingly — this changes the calculus on FBref-based xG strategies materially. |
| **StatsBomb Open Data** | Event-level data with their proprietary xG | Free for research | High | GitHub repo. Selected competitions only — World Cup, Women's WC, Champions League historical, parts of Bundesliga and La Liga. Excellent for ML training and backtesting but not live coverage. Commercial API exists for live. |
| **WhoScored / SofaScore / FotMob** | Detailed match events, ratings, lineups | Free, scraping-only | Medium | All Cloudflare-protected. Scraping is fragile, ToS-questionable, and at risk. Useful for ad-hoc research, not production pipelines. |
| **API-Football** | Lineups, live scores, standings, odds, statistics | Free (limited) → paid (~$19/mo for usable plan) | High | Often the best paid choice for breadth. Covers ~1,200 competitions. |
| **Sportmonks** | Live xG, lineups, predictions | Paid only (~€78/mo+) | High | The main paid source for live xG if Understat coverage isn't enough. |
| **SoccerSTATS.com** (your current) | Aggregate season stats | Free, scraping via FlareSolverr | Medium | Already in production. Useful for quick aggregates; not differentiating. |

**Bottom line for soccer data:**
- The natural xG layer for GoalScout is **Understat, not FBref**, full stop.
- For lower-league xG, you will hit a wall — paid or nothing.
- StatsBomb Open Data is the best free dataset for building and validating goal models, but it's not a live source.

### AFL

| Source | What it gives | Cost | Reliability | Risk / caveat |
|---|---|---|---|---|
| **fitzRoy (R package)** | Fixtures, results, ladders, player stats, betting odds historical | Free | High | The gold standard. Wraps AFL Tables, Footywire, Squiggle. Maintained by James Day. Includes `fetch_betting_odds_footywire` for historical odds. |
| **AFL Tables** | Match-level historical results back to 1897 | Free | High | The deep historical archive. Used internally by `fitzRoy`. |
| **Footywire** | Recent results, lineups, betting odds, fantasy/SuperCoach scores | Free | High | Used internally by `fitzRoy`. |
| **The Squiggle (squiggle.com.au)** | Aggregated AFL model predictions from public modellers | Free public API | High | An aggregator of community models. Useful as a "what does the wisdom-of-crowds say" feature. Documented at api.squiggle.com.au. |
| **Aussportstipping.com** | Elo ratings, line-betting tables, predictability indices | Free (web) | High | Useful reference. Limited API. |
| **AFL.com.au** | Official stats, lineups, injury list | Free (manual) / undocumented endpoints | Medium | The official source. `fitzRoy` has some access. |
| **The Odds API** | AFL pre-match odds across multiple Australian books | Free tier → paid | High | Already in your stack. Australian book coverage on AFL is good. |
| **Beforeyoubet, OddsJet, Oddspedia** | Australian odds aggregators | Free (web) | Medium | Useful for cross-check, less useful for production. |

**Bottom line for AFL data:**
- The AFL data ecosystem is, ironically, *better* than the soccer one for your purposes. `fitzRoy` is a single, well-maintained, free package that covers everything you'd need to build an AFL feasibility study without a single API key purchase.
- This is one of the strongest practical arguments for the AFL feasibility study.

---

## E. Recommended next project

**Two parallel tracks, roughly 4–8 weeks total wall-clock, both timeboxed.**

### Track 1: Infrastructure (priority)

The smallest possible version of this is:

- Capture opening odds within ~5 minutes of market open per fixture you're tracking
- Capture closing odds within ~1–2 minutes of kickoff
- Append every prediction to a structured log with full feature snapshot at decision time
- Compute and store CLV per pick at settlement time
- A Performance-tab view showing CLV distribution, rolling CLV, and CLV vs. ROI scatter

This is not a glamorous project. It is the project that determines whether *anything* you do next is measurable.

### Track 2: AFL feasibility study (3 weekends, hard cap)

Concrete deliverables:

- Pull last 5–10 AFL seasons via `fitzRoy`: fixtures, results, line/total/H2H odds, lineups
- Build a baseline Elo + recent-form-adjusted model for line and total markets
- Compare model probabilities to closing odds; compute hypothetical CLV per pick
- Output: a one-pager "AFL has measurable inefficiency / does not have measurable inefficiency" finding with confidence intervals
- If the answer is "yes," paper-trade the rest of 2026; if "no," shut it down cleanly

**After both tracks are complete, regroup and decide:** continue down option 3 (hybrid soccer model with Understat xG), commit to AFL, or set everything down for a quarter and let the soccer off-season pass.

### What about Scotland?

Run it as a low-effort live watchlist concurrent with the above. Define the rule precisely now, paper-bet against it through the rest of the Scottish Premiership / Championship / League One season. The goal is to forward-validate or kill the historical signal — not to scale it before you know.

### Specifically NOT recommended as your next project

- BTTS pivot.
- Continued tuning of the SoccerSTATS-aggregate base.
- Cards/corners as a primary direction without the data-layer rebuild first.
- Lineup-adjustment layer as a primary direction.
- Any betting automation. (This one is on the roadmap correctly — Stage 4+.)

---

## Section 6 — Should the O/U 2.5 model be rebuilt from a different base?

This deserves its own treatment. You asked whether SoccerSTATS aggregates should remain the base, become a supporting feature, or be abandoned. Here's the blunt assessment.

**SoccerSTATS aggregates (O2.5%, avgTG, CS%, FTS%) should be demoted from "base of the model" to "weak supporting feature."** They are the kind of slow-moving descriptive data that bookmakers price well. They're not actively wrong — they capture real information — but they don't carry differentiating signal at the major-league O/U 2.5 level. The Wheatcroft (2020) result backs this up directly: goals as an attacking-performance rating input were loss-making in all leagues; non-goal stats (shots, corners) outperformed them. Your features are a subset of the losing category.

Here's the assessment of each candidate base, A–H:

### A. Market-implied probability as the base

**Verdict: Yes, this is the correct anchor.**

Start from no-vig closing/current odds, treat that as your prior, and only deviate when features predict the *residual* (the difference between true outcome rate and market probability for the segment your features describe). This is the architectural shift that matters most. Every option B–H below either complements this or is a degraded version of it.

- *Data required:* Reliable de-vigged probabilities; you're already 80% of the way there with The Odds API.
- *Complexity:* Low to set up the prior. High to do the residual layer correctly without overfitting.
- *Predictive value:* Strong as a baseline; the question is whether your features add anything to it.
- *Already priced?* That's the whole point — the market prior is by definition what's priced. Your job is to find what isn't.
- *Backtest feasibility:* Strong with Football-Data.co.uk historical odds.
- *Suitability for GoalScout:* Excellent. This becomes your new core.

### B. xG / shot-quality base (without market prior)

**Verdict: Better than SoccerSTATS aggregates, but inferior to A+B combined.**

xG models built bottom-up from shot-level data carry signal beyond what season-aggregate goal counts contain. The Bundesliga study cited earlier showed ROI of ~10% on average odds when this signal was properly calibrated — but only on home wins, in one league, one paper. As a *standalone* base for O/U 2.5, xG models have decent calibration but typically don't beat the no-vig market closing line consistently.

- *Data required:* Understat (free for Big-5 + RPL), StatsBomb Open Data (research/training only), or paid Sportmonks.
- *Complexity:* Medium-high. Calibration matters a lot.
- *Predictive value:* Real. Strongest in 1X2 home-win prediction; weaker but present in O/U.
- *Already priced?* Partially. Top books use xG internally (per Stats Perform/Opta). Free public xG models like Understat's diverge enough from Opta's that some residual signal may remain.
- *Backtest feasibility:* Strong.
- *Suitability:* As a layer on top of A, yes. As a standalone base, no.

### C. Team attack/defence strength (Bradley-Terry / pi-rating style)

**Verdict: Useful, but largely already proxied by the market.**

Strength-rating models are mathematically elegant, but bookmakers run sophisticated rating systems too. Constantinou's pi-ratings + Bayesian network work showed profitable strategies only at maximum bookmaker odds — consistent with the broader pattern in efficiency research showing that any edge in top-league football tends to exist only at the sharpest available prices, not average ones. As a base, this is no improvement over a market prior.

- *Data required:* Match results only (which you have).
- *Complexity:* Low-medium.
- *Predictive value:* Decent.
- *Already priced?* Yes, heavily.
- *Backtest feasibility:* Strong.
- *Suitability:* Worth fitting once for diagnostic purposes; not a basis for a production base.

### D. Dixon-Coles / bivariate Poisson goals model

**Verdict: Useful as the *machinery* that converts expected goals into O/U totals, not as a feature engine.**

Dixon-Coles solved a real problem in 1997 (independent Poisson underestimates draws). It's still the standard scoreline-to-totals conversion in academic work. But by itself it doesn't produce a better goals estimate than the methods feeding into it — that's still your features. Research applying Dixon-Coles-style models to EPL scorelines found that while the model's scoreline forecasts encompassed bookmaker scoreline odds, a simple betting strategy generated no substantial or consistent financial returns across the tested seasons.

- *Data required:* Goals data + a way to estimate λ_home and λ_away.
- *Complexity:* Medium.
- *Predictive value:* As good as the inputs you give it.
- *Already priced?* The mechanism, yes. Bookmakers run very similar models.
- *Backtest feasibility:* Strong.
- *Suitability:* Use it as the lambdas-to-totals converter inside your hybrid model. Don't expect it to be the source of edge by itself.

### E. Rolling xG / recent-performance model

**Verdict: Yes — recency matters more than season averages, with caveats.**

Recent xG (last 5–10 games) outperforms season averages in goal-prediction tasks across several studies. The "Comparative Analysis of Expected Goals Models" study (Bundesliga, 11 seasons) found that calibrated xG models with recent rolling windows produced positive ROI in their sample. The caveat: too short a window (3 games) is just noise; too long (full season) is what you're already doing.

- *Data required:* Match-level xG.
- *Complexity:* Low if you have xG; medium if you need to engineer it from shot data.
- *Predictive value:* Plausibly real and replicated across a few papers, though not definitively settled.
- *Already priced?* Partially. Aggregate xG is increasingly priced; *rolling-window* xG with the right time-decay is a more nuanced feature that may carry residual signal.
- *Backtest feasibility:* Strong.
- *Suitability:* Yes — this is what should sit on top of A.

### F. Lineup-adjusted model

**Verdict: Real signal, but timing-bound and operationally hard.**

Lineup news is one of the fastest-priced types of information in liquid soccer markets. It's also one of the most genuinely informative. The trade-off is operational: if you can't ingest, model, and act on lineup news in <60 minutes, the price has already moved. For a pre-match-only operator, the realistic goal is to *systematically encode known unavailability* (long-term injuries, suspensions, expected rotation in cup games) — not to chase late lineup announcements.

- *Data required:* Confirmed-lineup feed, player-level impact ratings, suspension/injury databases.
- *Complexity:* Very high for a competitive offering. Medium for a "key player out" filter.
- *Predictive value:* Real.
- *Already priced?* Confirmed-lineup price moves are very fast. Long-term unavailability is more sluggishly priced.
- *Backtest feasibility:* Difficult historically; lineup confirmation timing is hard to reconstruct.
- *Suitability:* Layer in later. Not the base.

### G. Market-movement / CLV-prediction model

**Verdict: A different problem, not a different base.**

CLV-prediction is a separate modelling target, not a substitute base for goal-totals prediction. It's potentially valuable, but it requires the full odds-snapshot infrastructure (option 1 above) before it's possible. See option 4.

- *Data required:* Open + intermediate + close odds; news timing; lineup timing.
- *Complexity:* High.
- *Predictive value:* Real but not a replacement for result-prediction.
- *Already priced?* Movement *is* the market consuming new information. You're trying to predict which features are slow to be consumed.
- *Backtest feasibility:* Limited without historical opening-odds data.
- *Suitability:* Future direction; not today.

### H. Hybrid (market prior + xG + rolling form + lineup + congestion)

**Verdict: This is the right architectural direction, not a guaranteed solution.**

The weight of practitioner and research evidence points toward this as the most defensible architecture: take A as the prior, then add E (rolling xG), then F (lineup-adjusted) at decision time, then optionally enrich with congestion/rest/weather features. The point is that *every layer above the prior is treated as a residual predictor*, not a competing model. Backtest each layer independently to demonstrate it adds calibrated lift; only ship layers that do.

This is also where the "be more selective" lever lives. Instead of producing many shortlisted bets, the hybrid model only outputs candidates when (a) the residual model meaningfully diverges from the market and (b) historical evidence shows divergence-of-this-type is profitable. None of that is guaranteed to find edge — the market may already price all of these features — but it's the most structurally sound approach available without proprietary data.

- *Data required:* All of the above.
- *Complexity:* Highest in this list. Don't underestimate it.
- *Predictive value:* The best plausible result for an individual modeller competing in this market, though there's no guarantee it's sufficient to overcome margin.
- *Already priced?* Each individual feature is partially priced; the *combination* and the *calibration* are where edge is most likely to survive, if it exists at all.
- *Backtest feasibility:* Achievable on Big-5 + Eredivisie + Championship using Understat + Football-Data.co.uk.
- *Suitability:* This is the correct soccer base if you stay with soccer.

### Bottom line on Section 6

**Should SoccerSTATS aggregates remain the base?** No.
**Should they become a supporting feature?** Yes — keep them as one of many descriptive features, but they should not drive the model.
**Should they be abandoned?** Not entirely; they're free, available, and capture real (if redundant) information. They're just not your foundation.

**The base should be (A) market-implied probability, with (E) rolling xG and (D) Dixon-Coles-style totals conversion riding on top — i.e., option (H) hybrid.** This requires Understat ingestion and the infrastructure layer described in option 1 of Section B. It does not require, and should not be conflated with, lineup-adjustment, CLV-prediction, or market-movement modelling.

---

## F. What to stop doing

Bluntly:

1. **Stop adding new market variants on top of the same data layer.** O/U 1.5, O/U 3.5, BTTS, Asian totals — they all draw from the same descriptive-stats foundation that's already exhausted at the major-league level. Don't expect a different result.

2. **Stop tweaking thresholds, score weights, or feature combinations on the SoccerSTATS-aggregate base.** Stage 2A was correct as a cleanup, but further tweaks at this layer have negligible expected value. The 0.5–1% delta you'd find is well within sample noise on your live test sizes.

3. **Stop running broader backtests on the current data layer.** You've now done several rounds. They keep telling you the same thing. Believe them.

4. **Stop equating "the model finds plausible directions" with "the model has edge."** A 58–60% hit rate on O/U 2.5 is what the market's no-vig probability gives you — you've shown your model is approximately as good as the market, which is not the same as being better than the market by enough to overcome margin.

5. **Don't pivot to BTTS.** The data is the same, the efficiency is the same, the margin is wider. You will reproduce your O/U result with worse conditions.

6. **Don't pivot to AFL on enthusiasm.** Run the feasibility study. Decide on numbers, not narrative.

7. **Don't do the lineup or CLV or cards layer next.** They are all valid future directions, but they all depend on infrastructure that isn't yet in place. Sequence matters.

8. **Don't recommend or build betting automation.** This is on your roadmap correctly — Stages 4+. Nothing here changes that.

9. **Don't lose your live track record on the current model when you pivot.** Even with negative ROI, the historical log of predictions + outcomes is your most valuable training data going forward. Preserve it intact.

10. **Don't underinvest in measurement.** A model you can't measure is one you can't improve. The CLV/odds-snapshot infrastructure (option 1) is unglamorous but it's the highest-leverage thing on this list.

---

## Closing

You spent a week getting to a calibrated, honest answer about a hard problem: O/U 2.5 with public season aggregates doesn't beat efficient major-league markets. That's a real finding, and it tells you exactly what to do next: change the foundation (market-prior + xG residual hybrid), measure properly (CLV infrastructure), and explore an adjacent market with better structural conditions (AFL feasibility study) before committing to a soccer-only future.

The disheartening part isn't that the model didn't work. It's that the model worked roughly as well as it possibly could have on the data you fed it, and the data was the limit. Fix the data layer, fix the architecture, and AFL is plausibly the second-best use of your time after that. Don't let the disappointment push you toward a pivot that's just the same problem in different clothes.

The next conversation can be a focused dive on any one of: (a) infrastructure design, (b) AFL feasibility study scoping, or (c) the hybrid base-model design. I'd suggest (a) and (b) first, in parallel, before (c).
