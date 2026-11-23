---
name: formal-trade-roster-holds
description: Model-check the roster room that Pancake trade acceptances hold against waiver claims, final yeses, withdrawals and completions. Use when a change touches trade acceptance, trade roster holds, the roster capacity trigger, or waiver claim entry or processing.
---

# Formal check: trade roster holds

## The promise

Once an offer the team said yes to has its roster room, it keeps that room, counted with every unanimous trade the team is in, until it completes, ends, or the team withdraws.
An offer the team sends while its roster is already full starts without room; sending records the team's yes with no roster check. The model tracks this as `room`: it turns true the first time the held offer fits, for example after a drop.
If it breaks, the team's own waiver claim or another unanimous trade takes the spot the offer needs, and the partner's yes is refused or the offer is stranded.
Before #187 (`4be6c79d`), only unanimous trades held room, and both happened.

## Run it

```sh
npm run check:formal:trade-roster-holds
```

Add `-- --install` once to fetch TLC 1.7.4 into `~/.cache/pancake-formal`; the script checks its sha256.
It needs Java 11 or later on `PATH`, in `JAVA`, or from Homebrew `openjdk@21`. Set `TLA2TOOLS` to use another copy of the jar.
It takes a few seconds and exits 0 only when all three runs match `coverage.json`:

- `every-acceptance`: the current rule, two offers, roster limit 2. No invariant may fail.
- `unanimous-only`: the pre-#187 rule. `AcceptedOffersKeepRoom` must fail, and the last step must be a partner's final yes on one of two overlapping offers.
- `unanimous-only-one-offer`: the pre-#187 rule with one offer. `AcceptedOffersKeepRoom` must fail, and the last step must be waivers running on the team's claim.

The two expected failures keep the model able to fail. If either historical run stops failing, the model no longer describes the bug it guards.
The script also fails when a covered file changed since `syncCommit`. Recheck the model, then move `syncCommit`.

The database replay of the same failure paths runs on a disposable stack:

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:<private db port>/postgres npm run test:db:trade-hold-model-replay
```

On the current schema it prints each step and passes 3 checks. On `a3b4d277` the claim wins, the partner's yes is refused, and one of two offers is stranded.
Start the stack the way [verify-pancake](../verify-pancake/SKILL.md) or `docs/verification.md` describes. Never point it at a hosted database.

## The model

`tools/formal/trade-roster-holds/TradeRosterHolds.tla` tracks one team: its active roster count, each offer's status, whether the team said yes, and one waiver claim.
`Rule` picks the hold rule; everything else is the same for both rules.

| Model | Code |
| --- | --- |
| `Views`, `RosterGuard` | `private.trade_hold_conflicts`, `private.trade_hold_counts`; the old rule is `private.assert_accepted_trade_capacity` at `a3b4d277` |
| `TeamProposes` | `private.create_trade_offer`, which sets the proposer's `accepted_at` with no hold check, at both revisions |
| `TeamAccepts`, `PartnerFinalYes` | `private.accept_trade_participant_atomic` through `private.assert_trade_assets_acceptance_ready` and `private.assert_trade_acceptance_holds` |
| `TeamWithdraws` | `public.retract_trade_acceptance_atomic`, which did not exist before #187 |
| `TeamEntersClaim` | `public.create_waiver_claim_atomic`; at `a3b4d277` it had no roster room check |
| `WaiversRun` | `public.process_next_waiver_claim_atomic`; the roster insert fires `private.guard_accepted_trade_capacity` |
| `TradeCompletes` | `public.complete_accepted_trade_atomic` |
| `PartnerDeclines` | a partner rejects, the proposer cancels, or the offer expires |

Each action is one database transaction. Waiver processing checks holds right away through `private.assert_accepted_trade_capacity` and records `failed_roster`; other roster writes are checked by the deferred capacity trigger at commit.
Accepting also refuses when another held offer would not fit. The promise does not depend on that check, so removing it does not fail the model.

Read a failure with the pstack `/statechart` skill; it gives each violation as its shortest path in plain words. The check script prints the same path as numbered steps.

## Scope

Verified: every order of these steps for one team, two offers that each bring in one net player, and a roster limit of 2. A one-off run with three offers and a limit of 4 also passed (6,018 states).
Every offer brings in exactly one player, so all held offers gain room together; an offer that fits beside one that is over is never explored.
Not covered: a commissioner lowering the roster size, IR and taxi counts, the roster floor and auto-IR writers (`private.run_league_roster_floor`, `public.auto_manage_ir_service`), roster moves planned inside a trade, two offers that move the same player (the code releases that competing hold), other teams' rosters, FAAB, and lock timing.
The concurrency recipes `npm run test:db:trade-roster-holds-concurrency` and `npm run test:db:trade-waiver-concurrency` cover locking.

## Real bug or modeling error

When the current rule fails, write the trace as steps in the code's words and find the function behind each step.
If the code does take those steps, it is a real bug: report it and keep the invariant.
If a step is impossible in the code, fix the model, and say which function rules the step out.
Never weaken `AcceptedOffersKeepRoom` or drop a historical run to get a pass.

## Intended changes

When a change to the covered code is meant to change the rule, change the model in the same commit.
Break the new rule once in a scratch copy, such as skipping the hold check in `WaiversRun`, and confirm the check fails.
Update `tests/db/trade-hold-model-replay.sql` when a failure path changes.

## Coverage record

`tools/formal/trade-roster-holds/coverage.json` lists the covered files, the TLC version and checksum, and the expected result of each run.
`syncCommit` is the last commit at which the model was confirmed against those files. Move it only after you have rechecked the model at the new commit.
