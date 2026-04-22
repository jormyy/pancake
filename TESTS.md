# Test Cases Brainstorm

~60-70 distinct test cases across all areas.

---

## Scoring

- `calculateFantasyPoints` with all stat categories (pts, reb, ast, stl, blk, to, FG%, FT%)
- `didNotPlay` flag returns 0
- Double/triple double bonus triggers
- Null/missing stats don't crash
- Custom scoring settings (per-league overrides)

---

## Roster Management

- `isIREligible` — "out" and "ir*" pass, "dtd" fails, null/undefined fail
- `isTaxiEligible` — only players with `nba_draft_number != null`
- `addFreeAgent` — rejects when roster full (excluding IR + taxi slots)
- `addFreeAgent` — rejects when DTD player is on IR (ineligible IR blocks all adds)
- `dropPlayer` — puts player on waivers with correct `clears_at`
- `toggleIR` / `toggleTaxi` — clears associated lineup entries

---

## Waiver Processing (backend)

- Claims process in priority order (lowest number wins)
- First successful claim blocks others for same player in same run
- Claiming member moves to end of priority queue
- Fails with `failed_roster` if roster full and no drop specified
- Drops first, then adds (in correct order)
- Skips claims where player already cleared waivers
- Skips if member already owns the player
- Expired entries get cleared after run

---

## Auction Draft (backend)

- `nominatePlayer` — enforces turn order, rejects if not your turn
- `placeBid` — rejects bids ≤ current bid
- `placeBid` — rejects if current highest bidder tries to bid again
- `placeBid` — rejects if insufficient budget
- `placeBid` — extends `countdown_expires_at` on each bid
- `closeExpiredNominations` — awards player to winner, deducts budget
- `closeExpiredNominations` — no-bid player goes to free agency
- Draft auto-completes when all teams have budget < $1

---

## Snake Rookie Draft (backend)

- Pick order: inverse standings (worst record → first pick)
- Snake direction: round 1 goes 1→N, round 2 goes N→1, etc.
- Traded picks reflect `current_owner_id` (not original owner)
- `makeSnakePick` — rejects already-rostered player
- `makeSnakePick` — rejects already-picked player
- `autoPickBest` — picks lowest available `nba_draft_number`
- `reseedRookieDraftPicks` — fails if any picks already made
- Draft auto-completes when all picks made
- Roster overflow flag returned when active count > `roster_size`

---

## Matchup Generation

- Round-robin: every team plays every other team
- Correct number of matchups per week (N/2 or (N-1)/2 with bye)
- Bye week assigned for odd number of teams
- Idempotent: calling twice doesn't duplicate matchups

---

## Scoring Sync & Finalization

- `calcMemberWeekPoints` sums only starters (excludes BE and IR slots)
- Week does NOT finalize while any game is still Scheduled/InProgress
- Week finalizes once all games are Final
- `winner_member_id` assigned to higher point total
- Playoff weeks skipped during regular season sync

---

## Playoff Bracket

- Top 4 seeds by wins, then points-for as tiebreaker
- Matchups: Seed 1 vs 4, Seed 2 vs 3
- `advanceToFinal` fails if semis not both finalized
- Final scheduled at `playoff_start_week + 1`

---

## Lineup Auto-Set

- Players with games today preferred over players without
- Pure positions filled before flex (G, F, UTIL)
- Locked players (game already started) not moved
- Position eligibility respected (PG can't fill C slot, etc.)

---

## Week Number Calculation

- Week 1: Oct 21–26, 2025 (6-day special case)
- Week 2+: rolling 7-day weeks from Oct 27
- Gap days (between weeks) return most recent week
- `currentSeasonYear()` — month >= 9 returns current year, else next year

---

## Trades

- Proposal requires >= 1 asset on each side
- Only recipient can accept/reject
- Only proposer can withdraw
- Accepting transfers players and picks to correct members
- Can't accept a non-pending trade

---

## Non-Obvious Edge Cases

- **DTD on IR blocks everything** — not just the IR slot, but all FA adds and waiver claims too
- **Roster size excludes IR + taxi** — always count only active slots
- **`nba_games.week_number` is unreliable** — scoring sync uses date ranges, not week_number column
- **Waiver priority is ordinal, not score** — 1 = first priority, higher number = worse priority
