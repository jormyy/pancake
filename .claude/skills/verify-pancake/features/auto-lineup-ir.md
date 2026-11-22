# Auto Lineup injured reserve

Auto Lineup moves IR-eligible players into open IR slots, exchanges later-returning active players with earlier-returning eligible IR incumbents, and reports decisions it will not make alone.
It never drops a player and never touches taxi.
Invalid IR or taxi still blocks unrelated pickups and waiver claims, but never lineup edits, activation, drops, or corrective swaps.
Notices are computed from the current roster when Lineup opens or regains focus, so a scheduled run never leaves a stale notice behind.

## Sub-features

- `auto-ir-open-slot` designates an eligible bench player into an open IR slot.
- `auto-ir-swap` activates a healthy IR occupant and designates an eligible active player as one atomic swap.
- `auto-ir-incumbent` exchanges a later-returning active player with an earlier-returning eligible IR incumbent as one atomic pair.
- `auto-ir-notices` reads live manager decisions on Lineup open and refocus for a full bench, uncertain returns, and ineligible taxi players.
- `auto-ir-manual-swap` offers `Swap with injured player` in the IR resolution sheet.
- `auto-ir-background` runs the same resolution from the background optimizer.

## How to get to it (user POV)

- Lineup → open the screen; Auto Lineup notices load on open and on refocus, with no pin change.
- Home → Auto-set → Edit lineup manually → Lineup screen notices.
- Roster → Resolve roster → Activate the healthy IR player → choose IR for the injured player → Move and activate.
- Players → Claim any player while IR is invalid → Resolve roster → `Swap with <injured player>`.

## Driving it with agent-browser

Preconditions:

- A fresh disposable stack launched from this branch.
- `node tools/verify/seed-auto-ir.mjs "$EVIDENCE" --case=<name>` has run.
- Read the involved player names and ids from the seeder’s JSON, not from the fixture.

Cases: `open-slot`, `full-bench-swap`, `no-legal-swap`, `swap-available`, `swap-locked`, `uncertain`, `locked`, `taxi-ineligible`, `incumbent-exchange`, `incumbent-tie`, `incumbent-boundary-tie`, `incumbent-unknown`.

- **Seed.** Run the seeder for one case. It reshapes E2E Team 1, enables that member’s lineup optimizer, and prints JSON. Re-running the same case resets and reapplies it.
- **Before.** Run `node tools/verify/observe.mjs "$EVIDENCE" > "$EVIDENCE/auto-ir-before.json"`. Require `roster_players.is_on_ir`/`is_on_taxi`, the team’s `roster_transactions`, and the `players` injury fields.
- **Trigger (background).** Run `node tools/verify/trigger-lineup-optimizer.mjs "$EVIDENCE"`. It posts to the local Edge route with the run’s generated internal token and prints the optimizer JSON. The token is never printed.
- **Notices (live read).** Open Lineup without touching any Start/Auto/Bench control. Require the notice name, reason text, and action from the seeder JSON. Close Lineup, reopen it, and require the same notice again. The notice comes from the live read on open and refocus, not from the optimizer response.
- **Trigger (Lineup screen).** Use the visible Auto lineup control. After the run, the notice list refreshes from the live read; no pin change is required.
- **After.** Repeat the observation into `auto-ir-after.json`. Require the expected `is_on_ir` flags and `roster_transactions` rows (`ir_designate`, `ir_return`).
- **Incumbent exchange.** For `incumbent-exchange`, require the 60-day contender on IR and the 7-day incumbent active, with the 30-day incumbent still on IR. For `incumbent-tie`, `incumbent-boundary-tie`, and `incumbent-unknown`, require no roster change and the `ir_choice_uncertain` notice.
- **Locked swap partner.** For `swap-locked`, require no roster change and the `healthy_ir_swap_locked` notice. The reason text is `Healthy on IR, but the active roster is full. The injured player who could take the spot is locked by a game or a pending move.` and the action is `Swap <name> with an injured player after their game or pending move clears`. The notice must not advise a swap that the game lock would reject.
- **Manual swap.** For `full-bench-swap` and `swap-available`, either path above must leave the healthy occupant active and the injured player on IR. The roster sheet repeats each `Move ... to IR` label behind the dialog; click `[role="dialog"] [aria-label="Move <name> to IR"]`, then `Move and activate`.
- **Pickup gate.** With IR invalid, a claim must open Resolve roster and write no `waiver_claims` row until the roster is legal.
- **Widths.** Repeat the notice and manual swap at 375×812.

## Expected results

| Case | Stored result | Visible result |
| --- | --- | --- |
| `open-slot` | candidate `is_on_ir=true`, `ir_designate` transaction | candidate under IR |
| `full-bench-swap` | occupant `is_on_ir=false`, candidate `is_on_ir=true`, `ir_return` and `ir_designate` | swap reflected in both groups |
| `no-legal-swap` | no roster change | `healthy_ir_bench_full` notice with `Drop a player, then activate <name>` |
| `swap-available` | no roster change | `healthy_ir_swap_available` notice with `Swap <name> with an injured player` |
| `swap-locked` | no roster change | `healthy_ir_swap_locked` notice with `Swap <name> with an injured player after their game or pending move clears` |
| `uncertain` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |
| `locked` | no roster change | no notice; the candidate is retried next run |
| `taxi-ineligible` | no roster change | `taxi_ineligible` notice with `Activate <name> from taxi or drop a player` |
| `incumbent-exchange` | 60-day contender `is_on_ir=true`, 7-day incumbent `is_on_ir=false`, 30-day incumbent `is_on_ir=true`, `ir_return` and `ir_designate` | one exchange; the 30-day incumbent stays |
| `incumbent-tie` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |
| `incumbent-boundary-tie` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |
| `incumbent-unknown` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |

## League-wide auto IR

A league whose `private.league_roster_policies` row has `auto_ir_all_members=true` runs the same legal IR resolution for every member, including members whose Auto Lineup is off.
The daily check and every pre-tipoff window resolve IR first, then read the roster again before choosing starters.
Starters are chosen only for members whose Auto Lineup is on.
An Auto Lineup off member keeps manual starters; a player moved to IR leaves the lineup and the slot stays empty.
Leagues without the policy keep the opt-in behavior.

Sub-features:

- `league-auto-ir-daily` admits every policy member on every Eastern date, including days with no scheduled NBA game, and applies IR only for a manual member.
- `league-auto-ir-retry` retries a transient IR failure inside the run, writes no durable member receipt, and leaves the dispatch retryable with unchanged inputs. A transient SQLSTATE returned in `skipped` re-raises for a policy league, so the worker sees a failure instead of a skip; an ordinary skip still completes the run. HTTP service, load and timeout statuses (408, 425, 429, 500, 502, 503, 504) are retryable at the IR boundary for the policy path, while a 4xx validation refusal stays a permanent member failure.
- `league-auto-ir-recovery` runs the official league's tipoff work as its own `pre-tipoff-policy` item and dispatch scope, keyed by tipoff and league, with a 45-second lease, a 5-second retry, and no dead-lettering before tipoff. The shared `pre-tipoff` item serves only leagues without an activated policy and keeps the five-minute lease and base backoff; an old worker is refused the scoped claim with `PT409`.
- `league-auto-ir-fingerprint` keeps the shared `pre-tipoff` fingerprint as the legacy 009700 body and excludes activated policy leagues, and gives each policy league its own `pre-tipoff-policy` fingerprint over its members' Auto Lineup mode, scoring, roster size and IR slots, roster with injury status, expected return and career games, IR and taxi flags, trade and claim reservations, pins, slots, projections, and the date's games. A return-date correction, a released reservation, or an Auto Lineup flip reopens only that league's completed dispatch; an other-league change reopens only the shared dispatch.
- `league-auto-ir-completion` keeps IR completion and starter completion as separate receipts. An IR-only pass does not hide the member from starter work after Auto Lineup is enabled, a starter pass does not re-run IR, and a mode-unchanged retry writes nothing.
- `league-auto-ir-dormancy` requires `ir_activated_at` for the daily and pre-tipoff schedulers and admission, so a policy row with a NULL latch enqueues nothing new.
- `league-auto-ir-activation` starts an all-manual league only through `private.activate_league_roster_policy(league_id)`, which sets both latches together. No migration, worker, or scheduler activates the policy.

Run `npm run test:db:r8-tipoff-isolation` before the visible journey. It builds a production-head stack, proves the five migrations leave an open shared window's legacy fingerprint and revision unchanged, then proves an official Auto Lineup flip, an official-only injury or reservation, and an other-league eligibility change reopen only their own scope.

Seeder options:

- `--auto-lineup=on|off` sets the member's Auto Lineup switch. The default is `on`.
- `--league-policy=on|off` writes or removes the league policy row. The default is `off`.
- `--starter=on|off` puts the case candidate in a free starting slot on the printed `starterDate`. The default is `off`.
- `--injury=out|healthy` sets the `open-slot` candidate's injury status. The default is `out`.
- `--locked=on|off` adds a second injured `open-slot` player whose game is already in progress. The default is `off`.

The seeder writes the same JSON to `auto-ir-seed.json` in the evidence directory.
The trigger reads that file for the candidate and the fixture member.

Trigger options:

- `node tools/verify/trigger-lineup-optimizer.mjs "$EVIDENCE" --mode=daily` posts the daily check for today.
- `node tools/verify/trigger-lineup-optimizer.mjs "$EVIDENCE" --mode=pre_tipoff --tipoff=<ISO>` creates a game for every roster NBA team at that tipoff, creates the dispatch, then posts the window.
- `--candidate-injury=healthy|out` changes the seeded candidate's injury status before the window.
- An activated policy league uses `scope = <league id>` and posts `{mode, tipoffAt, token, leagueId}`. A league without an activated policy uses the shared `scope = ''` and posts no `leagueId`.
- The tool prints `dispatch` (the row before the request), `stored.dispatch` (the row after), `stored.dispatches` (every scope at that tipoff), `stored.members`, `stored.rosterTransactions`, `stored.lineup`, and `stored.ir`. It exits non-zero unless the stored dispatch is `succeeded`.
- The claim token is never printed.

Journey:

- **Notice.** Seed `--case=uncertain --auto-lineup=off --league-policy=on`. Open Lineup. Require the `ir_choice_uncertain` notice and `Choose who moves to IR` at 390×844 and 375×812. The switch reads off.
- **Background IR move.** Seed `--case=open-slot --auto-lineup=off --league-policy=on --starter=on`. Observe before. Open Lineup, select the seeder’s `starterDate`, and require the candidate in the printed `starterSlot` and an empty IR slot. Run the daily trigger. Observe after: the candidate is on IR, the starter row is gone, and the slot is empty. Reopen Lineup, select `starterDate`, and require the empty slot at 390×844 and 375×812.
- **Staggered tipoffs.** Seed `--case=open-slot --auto-lineup=off --league-policy=on --starter=on --injury=healthy --locked=on`. Run `--mode=pre_tipoff`; require `stored.dispatch.status: succeeded`, `stored.dispatch.scope` equal to the fixture league id, `stored.dispatches` with only that scope, and no `ir_designate` row. Set the candidate Out with `--candidate-injury=out` and run a later `--mode=pre_tipoff`; require an `ir_designate` row for the candidate, the candidate `isOnIr: true`, the candidate’s starter row gone from `stored.lineup`, and the other starter rows unchanged. Require the `lockedInjured` player still `isOnIr: false`.
- **Auto starters.** Seed `--case=open-slot --auto-lineup=on --league-policy=on --injury=healthy`. Run `--mode=pre_tipoff`; require `stored.lineup` rows with `isAutoSet: true` and the candidate in a starting slot.
- **Control.** Seed `--case=uncertain --auto-lineup=off --league-policy=off`. Open Lineup and require no notice. Run the daily trigger and require no IR move and no lineup change.

## Database recipes

Run these on the disposable stack before the visible journey:

- `npm run test:db:league-auto-ir-policy`, `npm run test:db:league-auto-ir-schedule`, and `npm run test:db:league-auto-ir-tipoff-concurrency` cover the policy, the schedule, and the tipoff claim.
- `npm run test:db:auto-manage-ir` and `npm run test:db:auto-manage-ir-concurrency` cover the service and its locks.
- `npm run test:db:r4-cases` covers the off-day daily admission, the transient retry, the crash recovery lease, the fingerprint inputs, and the NULL-latch dormancy.
- `npm run test:db:r5-cases` covers the transient-skip contract, the explicit activation of an all-manual league, the scoped lease, and the averages gate.
- `npm run test:db:r5-red` is the base-compatible red probe for the same four findings.
- `npm run test:db:r5-ir-transient` holds a real player row past the service lock timeout, requires the IR RPC to fail, the floor to defer with no awards, and the released retry to perform the move and complete the floor for an Auto Lineup team and a manual team.
- `npm run test:db:r7-mode-aware-tipoff` covers the mode-aware fingerprint, the distinct IR and starter receipts, the disabled-member guard, the idempotent retry, and the old-worker `PT409`.
- `deno test --allow-env --allow-net --allow-read supabase/functions/lineup-optimizer/preTipoff.test.ts` covers the worker’s transient retry and the later successful attempt.
- `deno test --allow-env --allow-net --allow-read supabase/functions/lineup-optimizer/irHttpRetry.test.ts` covers the HTTP status retries, the exhausted retry, the abort, the ambiguous response, the business-rule skip, the 4xx refusal, the legacy path, and the daily path.

## Gotchas

- The seeder is destructive to E2E Team 1; recreate the run before unrelated roster journeys.
- A started NBA game locks the candidate; the `locked` and `swap-locked` cases insert a started game for that player’s team.
- The first `browser.sh login` after launch can fail once; the helper retries once.
- The seeder writes plain fixture rows and does not require `public.auto_manage_ir_service` or `public.get_auto_ir_notices` to exist.
- Notices are never stored. Opening Lineup after a scheduled run must show the current roster’s notices without a pin change; reopening must show them again.
- `no-legal-swap` has no IR-eligible active player, so its advice is a cut. `swap-available` has eligible active players, so its advice is the manual swap. `swap-locked` has an eligible active player who is game-locked, so its advice waits for the lock to clear.
