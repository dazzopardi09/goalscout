# GoalScout Replay v1 Foundation

## Purpose

This document explains the initial historical replay foundation prepared for GoalScout.

The goal is to build a replay pipeline that can simulate what the model would have seen **before kickoff** for historical fixtures, without using future information.

This is the foundation only.
It is **not** the full replay runner yet.

---

## Scope

Current scope:

- EPL only
- 2025–26 season data
- file-based only
- no xG
- no odds/value layer
- no UI
- no database

This foundation is for:
- canonical historical fixtures
- point-in-time slicing
- recent team match extraction
- replay feature building

---

## Core rule

## No data leakage

For any target fixture, replay features must only use:

- fixtures with `status === "completed"`
- fixtures with `kickoffUtc < targetFixture.kickoffUtc`

The replay system must never use:

- future matches
- the target fixture result itself
- end-of-season aggregates
- current snapshot stats that include later matches

---

## Files created

## Historical data

### `data/historical/epl_2025_26_raw.json`
Raw EPL source file downloaded from Fixture Download.

This is the source import file only.
Do not build replay logic directly on this file.

### `data/historical/epl_2025_26_fixtures.json`
Canonical transformed historical fixture file for replay use.

Schema:

- `fixtureId`
- `leagueKey`
- `leagueName`
- `season`
- `kickoffUtc`
- `homeTeam`
- `awayTeam`
- `homeGoals`
- `awayGoals`
- `status`

Example:

```json
{
  "fixtureId": "epl_2025-08-15_liverpool_bournemouth",
  "leagueKey": "epl",
  "leagueName": "England - Premier League",
  "season": "2025-26",
  "kickoffUtc": "2025-08-15T19:00:00Z",
  "homeTeam": "Liverpool",
  "awayTeam": "Bournemouth",
  "homeGoals": 4,
  "awayGoals": 2,
  "status": "completed"
}
