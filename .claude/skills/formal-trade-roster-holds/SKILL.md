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
CI runs it through `npm run check:gate` in `.github/workflows/ci.yml` on every pull request and push to `main`.
It takes a few seconds and exits 0 only when all five runs match `coverage.json`:

- `every-acceptance`: the current rule, two offers, roster limit 2. No invariant may fail.
- `unanimous-only`: the pre-#187 rule. `AcceptedOffersKeepRoom` must fail, and the last step must be a partner's final yes on one of two overlapping offers.
- `unanimous-only-one-offer`: the pre-#187 rule with one offer. `AcceptedOffersKeepRoom` must fail, and the last step must be waivers running on the team's claim.
- `unanimous-only-archived-waiver-order`: the pre-#187 rule in the database replay's order. `AcceptedOffersKeepRoom` must fail after exactly these steps: the team enters a claim while it still has room, sends an offer, and waivers run.
- `every-acceptance-archived-waiver-order`: the current rule in the same order. `NoWaiverClaimRefused` must fail after the same three steps, which shows the hold check in waiver processing refuses the claim. The current rule refuses a claim entered after a hold, so the shorter historical path never reaches that check.

The two archived-order runs use the action constraint `ArchivedWaiverOrder`: a hold starts only by sending an offer while the claim waits, and waivers run only after a hold exists.
The expected failures keep the model able to fail. If a historical run stops failing, the model no longer describes the bug it guards; if the current-rule witness stops failing, waiver processing no longer reaches its hold check.

## Drift guards

The script fails before running TLC when the code the model describes may have moved:

- **Migration SQL.** `coverage.json` records the migration set the model was reviewed against: the last file name in `supabase/migrations` and a sha256 of every `*.sql` name and its bytes up to it. The check reads the files on disk, so a new or edited migration fails whether it is committed, staged, untracked or ignored by Git. Review each listed file against the Model table, update the model and replay if it changes what they describe, then run `node tools/formal/trade-roster-holds/check.mjs --record-migrations` and rerun the check.
- **Named sources.** `git diff syncCommit` over the by-name function files in `files`. Recheck the model, then move `syncCommit`.

The migration guard is deliberately broad. These fail it on purpose, and each needs a review and a re-record even when nothing in the model changes: any migration unrelated to trades, a whitespace or comment edit, a deleted or renamed migration, a stray `.sql` scratch file left in `supabase/migrations`, and line-ending changes from a checkout setting. It does not parse SQL, and it does not cover `supabase/seed.sql`, which only seeds local stacks.

## What a run needs

- **Clone depth.** The named-source guard diffs against `syncCommit`, so the clone must contain that commit. A shallow clone fails with an instruction to run `git fetch origin <syncCommit>` or `git fetch --unshallow`. The migration guard and TLC need no history.
- **Database baseline.** The replay needs a disposable local stack whose schema is every migration in the checked-out `supabase/migrations`, applied in order by `supabase start` or `supabase db reset` from that checkout, with no hosted data. Replaying against a stack migrated from another commit tests that commit, not this one.

The database replay of the same failure paths runs on a disposable stack:

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:<private db port>/postgres npm run test:db:trade-hold-model-replay
```

It prints each step, then a pass or FAIL line for each of 5 expectations, and exits nonzero if any failed, so each path keeps its own evidence.
On the current schema all 5 pass: waivers run refuses the claim, the partner's yes makes the offer unanimous (status `accepted`; it has not completed), and both overlapping offers stay pending.
On `a3b4d277` all 5 fail: the claim wins, the partner's yes is refused, the first of two overlapping offers becomes unanimous, and the second is stranded.
Start the stack the way [verify-pancake](../verify-pancake/SKILL.md) or `docs/verification.md` describes. Never point it at a hosted database.

## The model

`tools/formal/trade-roster-holds/TradeRosterHolds.tla` tracks one team: its active roster count, each offer's status, whether the team said yes, and one waiver claim.
`Rule` picks the hold rule; everything else is the same for both rules.

| Model | Code |
| --- | --- |
| `Views`, `RosterGuard` | `private.trade_hold_conflicts`, `private.trade_hold_counts`; the old rule is `private.assert_accepted_trade_capacity` at `a3b4d277` |
| `TeamProposes` | `private.create_trade_offer`, which sets the proposer's `accepted_at` with no hold check, at both revisions |
| `TeamAccepts`, `PartnerFinalYes` | `private.accept_trade_participant_atomic` through `private.assert_trade_assets_acceptance_ready` and `private.assert_trade_acceptance_holds` |
| `TeamWithdraws` | `public.retract_trade_acceptance_atomic`, which did not exist before #187; since `20261226000000` it only clears the caller's acceptance on a pending offer of three or more teams that another team has not accepted, a subset of what the model allows. A two-team proposer releases its hold through `PartnerDeclines` |
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

`tools/formal/trade-roster-holds/coverage.json` lists the covered files, the reviewed migration set, the TLC version and checksum, and the expected result of each run.
`syncCommit` is the last commit at which the model was confirmed against those files. Move it only after you have rechecked the model at the new commit.
