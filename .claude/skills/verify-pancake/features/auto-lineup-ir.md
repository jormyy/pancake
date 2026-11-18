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

Cases: `open-slot`, `full-bench-swap`, `no-legal-swap`, `swap-available`, `uncertain`, `locked`, `taxi-ineligible`, `incumbent-exchange`, `incumbent-tie`, `incumbent-unknown`.

- **Seed.** Run the seeder for one case. It reshapes E2E Team 1, enables that member’s lineup optimizer, and prints JSON. Re-running the same case resets and reapplies it.
- **Before.** Run `node tools/verify/observe.mjs "$EVIDENCE" > "$EVIDENCE/auto-ir-before.json"`. Require `roster_players.is_on_ir`/`is_on_taxi`, the team’s `roster_transactions`, and the `players` injury fields.
- **Trigger (background).** Run `node tools/verify/trigger-lineup-optimizer.mjs "$EVIDENCE"`. It posts to the local Edge route with the run’s generated internal token and prints the optimizer JSON. The token is never printed.
- **Notices (live read).** Open Lineup without touching any Start/Auto/Bench control. Require the notice name, reason text, and action from the seeder JSON. Close Lineup, reopen it, and require the same notice again. The notice comes from the live read on open and refocus, not from the optimizer response.
- **Trigger (Lineup screen).** Use the visible Auto lineup control. After the run, the notice list refreshes from the live read; no pin change is required.
- **After.** Repeat the observation into `auto-ir-after.json`. Require the expected `is_on_ir` flags and `roster_transactions` rows (`ir_designate`, `ir_return`).
- **Incumbent exchange.** For `incumbent-exchange`, require the 60-day contender on IR and the 7-day incumbent active, with the 30-day incumbent still on IR. For `incumbent-tie` and `incumbent-unknown`, require no roster change and the `ir_choice_uncertain` notice.
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
| `uncertain` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |
| `locked` | no roster change | no notice; the candidate is retried next run |
| `taxi-ineligible` | no roster change | `taxi_ineligible` notice with `Activate <name> from taxi or drop a player` |
| `incumbent-exchange` | 60-day contender `is_on_ir=true`, 7-day incumbent `is_on_ir=false`, 30-day incumbent `is_on_ir=true`, `ir_return` and `ir_designate` | one exchange; the 30-day incumbent stays |
| `incumbent-tie` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |
| `incumbent-unknown` | no roster change | `ir_choice_uncertain` notice with `Choose who moves to IR` |

## Gotchas

- The seeder is destructive to E2E Team 1; recreate the run before unrelated roster journeys.
- A started NBA game locks the candidate; the `locked` case inserts a started game for that player’s team.
- The first `browser.sh login` after launch can fail once; the helper retries once.
- The seeder writes plain fixture rows and does not require `public.auto_manage_ir_service` or `public.get_auto_ir_notices` to exist.
- Notices are never stored. Opening Lineup after a scheduled run must show the current roster’s notices without a pin change; reopening must show them again.
- `no-legal-swap` has no IR-eligible active player, so its advice is a cut. `swap-available` has eligible active players, so its advice is the manual swap.
