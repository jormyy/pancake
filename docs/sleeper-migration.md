# Sleeper → ESPN player-source migration

Sleeper announced (Aug 2026) that commercial API use moves behind negotiated
licensing, so Pancake no longer depends on it. The player master list (names,
teams, positions, injury status) now comes from ESPN's keyless public JSON:

- Teams + rosters: `site.api.espn.com/apis/site/v2/sports/basketball/nba/teams`
  and `/teams/{id}/roster`
- Injuries: `.../nba/injuries` (statuses mapped: `Day-To-Day` → `DTD`; `Out`,
  `Questionable`, `Doubtful` pass through)

NBA person IDs (headshots, box-score joins) continue to come from the NBA CDN
`playerIndex.json`, unchanged.

## Cutover design

- `sync-players` reads `PLAYER_SYNC_SOURCE` (default `espn`). Setting it to
  `sleeper` re-activates the old path unchanged — Sleeper stays as a dormant,
  flagged fallback.
- `players.espn_id` was added (unique, additive). `players.sleeper_id` is
  untouched: existing sleeper-keyed IDs keep resolving; no destructive re-key.
- ESPN positions are coarse (`G`/`F`/`C`). The ESPN sync never overwrites a
  finer existing position/eligibility set; it only fills players that have
  none (new rookies get their exact positions later from draft/rankings data).
- Degraded-source contract: payloads under 28 teams or 350 players are refused
  outright (no writes), so a truncated or reshaped response can never blank
  existing players; the next good sync self-heals with no manual action.

## years_exp semantics

ESPN's `experience.years` counts the upcoming season for veterans (+1 vs
Sleeper's completed-seasons count on ~70% of matched players at verification
time) but agrees exactly at `0` for rookies — the only value the product
gates on (taxi/rookie-draft eligibility). Veteran counts are display-only.

## CI note

The release soak intentionally pins `PLAYER_SYNC_SOURCE=sleeper` with the fake
upstream, which keeps the dormant fallback path exercised on every release.
The production default is `espn`.

## Side-by-side parity runs

`npm run parity:players` fetches both sources live and appends a row here plus
a JSON artifact in `docs/sleeper-migration-parity/`. Cutover required 3+
consecutive verified syncs. Coverage is measured over Sleeper's *rostered*
players (Sleeper also carries hundreds of unrostered/stale entries that no
league can roster).

| ran at (UTC) | sleeper rostered | espn rostered | matched (coverage) | team agree | position group agree | injured sleeper/espn, both & agreement | unmatched |
|---|---|---|---|---|---|---|---|
<!-- parity-runs -->
| 2026-08-15T11:25:35.976Z | 559 | 546 | 537 (96.1%) | 99.3% | 79.1% | 78/77, both 77 agree 100% | 22 |
| 2026-08-15T01:08:21.277Z | 559 | 546 | 537 (96.1%) | 99.3% | 79.1% | 78/77, both 77 agree 100% | 22 |
| 2026-08-15T01:08:04.012Z | 559 | 546 | 537 (96.1%) | 99.3% | 79.1% | 78/77, both 77 agree 100% | 22 |
| 2026-08-15T01:07:08.597Z | 559 | 546 | 537 (96.1%) | 99.3% | 79.1% | 78/77, both 77 agree 100% | 22 |
