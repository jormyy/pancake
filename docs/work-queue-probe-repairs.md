# Database probe repairs

League event writes use the existing league version helper through statement triggers.
Insert, update, and delete each capture the affected leagues.
The helper merges changes into one version per league per transaction.
The change log and version hint refresh screens and their cached data.
All seven direct event writers receive this protection.

| Event writer | Source |
| --- | --- |
| `private.log_league_activity` | Trade offers, counters, and edits |
| `private.work_capture_outcome` | Claim, trade, draft, score, and settings outcomes |
| `private.work_finish` | Worker success and terminal failure |
| `private.history_restore_lineups` | Historical lineup repair |
| `private.publish_trade_changes` | Deferred trade events |
| `public.auto_set_lineup_atomic` | Lineup changes |
| `public.update_lineup_slots_atomic` | Lineup slot settings |

Global worker events have no league and appear in no league screen.
They cannot advance a league version.
Trade events wait in private storage until publication inserts the public event.
Publication then advances the league version.
Unchanged rows and empty writes create no screen change.
The coverage probe adds no table exemptions.

## Previously uncovered RPC paths

The unmodified probe reports these 21 paths at the 625-migration candidate.
Each reaches a write to `public.league_events`.

- `accept_trade_atomic`
- `accept_trade_with_plan_atomic`
- `add_free_agent_atomic`
- `add_trade_block_item_atomic`
- `apply_pre_tipoff_lineup`
- `auto_set_lineup_atomic`
- `auto_set_lineup_service_atomic`
- `commissioner_adjust_faab_balance_atomic`
- `commissioner_override_weekly_add_count_atomic`
- `complete_accepted_trade_atomic`
- `drop_and_add_free_agent_atomic`
- `finish_edge_invocation`
- `process_due_accepted_trades_atomic`
- `process_due_waiver_claims_atomic`
- `process_next_waiver_claim_atomic`
- `propose_multi_team_trade_atomic`
- `propose_trade_atomic`
- `remove_trade_block_item_atomic`
- `submit_trade_offer_atomic`
- `update_league_configuration_atomic`
- `update_lineup_slots_atomic`

## Public read retention

Public read retention runs through the work dispatcher.
Its bounded SQL delete needs no separate scheduler.
The dispatcher already handles SQL maintenance with leases, retries, and completion events.
The migration removes the separate cron job and registers a SQL work kind.
Hourly work becomes due at minute seventeen and catches up later in the same hour.
One key per hour prevents duplicate work.
The existing seven-day cutoff, batch limit, and lock behavior stay in the pruning function.
The two existing direct maintenance jobs keep their current exclusions in the lifecycle probe.

## Regression checks

Both original probes fail before the migration.
The new event-only write check and retention enqueue check also fail before the migration.
The coverage probe checks that removing either event or roster protection causes failure.
Event checks cover inserts, updates, deletes, batches, rollback, deferred publication, and scoped worker completion.
They also read the version response and the visible team timeline.
Retention checks cover timing, catch-up, duplicate suppression, execution, cutoff preservation, and cron removal.


## Verification results

Both requested probes pass after the repair.
The broader all-green requirement remains unmet.
The isolated sweep records 248 passing cases and 47 inherited failures.
No case passes before the repair and fails after it.
Eight failing cases now pass, including both new regression recipes.

| Check | Result |
| --- | --- |
| `league-version-coverage.sql` | Pass; 147 RPC paths, including 111 atomic paths |
| `work-queue-lifecycle.sql` | Pass; 27 checks |
| `league-version-events.sql` | Pass; 29 checks |
| `public-read-retention-queue.sql` | Pass; eight checks |
| `screen-publication-versions.sql` | Pass; seven checks; wrong-port control fails |
| Focused Vitest files | Pass; 810 tests across 12 files on Node 22.23.2 |
| Scheduler Node tests | Pass; 19 tests |
| `npm run check:quality` | Pass on Node 22.23.2 |
| Function source and database catalog checks | Pass; 503 functions |
| Database type check | Pass |
| Release attestation check | Pass; 626 migrations |
| Fresh installation and upgrade comparison | All four generated files match byte for byte |

The fresh installation applies all 625 original migrations and the new repair migration.
A separate upgrade starts with the 625-migration schema and applies only the repair migration.
Both use the authorized private project and port block.
Both original probes also fail against the original 625-migration installation.
The separate cron job exists there before the repair.

The isolated sweep inventories all 301 SQL files.
It runs 292 root recipes with three calendar cases and both notification modes.
That produces 295 cases against each schema.
Nine SQL files serve as included fragments.
Five version-write fragments remain unreachable because their parent recipe fails at trade proposal.
The baseline records 240 passes and 55 failures, including the two new regression recipes.
The repaired schema records 248 passes and 47 failures.
The isolated baseline restores the prior functions and cron entry, then removes the repair triggers and work kind.

Five recipes need data or caller inputs absent from the empty private stack.
These are forecast cache parity, trade proposal budget, public CLI, trade values, and trade value readers.
Their recorded failures do not prove a product defect.
The other failures include removed scheduler calls and older timing or authorization expectations.
This repair leaves those failures unchanged.
No production data, remote deployment, or CI run supplies this evidence.

### Commands

Database commands run only on the mini.
`SUPABASE_DB_URL` uses loopback port `58722`.
`PANCAKE_TEST_DB_PORT` is `58722`.
The isolated runs use separate database copies inside that private stack.
`SUPABASE_URL` uses loopback port `58721` when a recipe requires it.

```sh
supabase db reset --local --no-seed
supabase migration up --db-url "$SUPABASE_DB_URL"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-coverage.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/work-queue-lifecycle.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-events.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/public-read-retention-queue.sql
node scripts/regenerate-release-history-attestations.mjs
npm run generate:db-function-catalog
npm run generate:database-types
npm run check:db-function-catalog
npm run check:database-types
```

The isolated runner executes each root with `psql -X -v ON_ERROR_STOP=1 -f`.
It supplies calendar cases and notification modes through their existing inputs.
Private receipts retain the runner, case results, and raw SQL output.
The screen publication recipe now reads the same private-port override as the other version recipes.
Its loopback requirement remains enforced.

```sh
npx vitest run tests/db-function-source-parity.test.ts tests/db-security-catalog-contract.test.ts tests/release-history-attestations.test.ts tests/e2e-attestation-head.test.ts tests/lib/league-version.test.ts tests/hooks/use-league-version.test.ts tests/lib/cache/screen-cache.test.ts tests/dispatcher-postgres.test.ts tests/dispatcher-worker.test.ts tests/public-cli/public-api.test.ts tests/public-cli/cli.test.ts tests/season-sim-cron.test.ts
node --test scripts/season-sim/cron.test.mjs scripts/season-sim/migration-cron.test.mjs scripts/season-sim/cron-dispatcher.test.mjs
npm run check:quality
node scripts/regenerate-release-history-attestations.mjs --check
```

### Unchanged inherited failures

Each case below also fails against the 625-migration comparison schema.
These failures prevent the requested all-green completion signal.
The completed checks above need no repetition unless their inputs change.

| Recipe | Observed failure |
| --- | --- |
| `correlated-dispatch.sql` | function public.invoke_edge_function_at_et_time(unknown, integer, integer) does not exist |
| `cron-dispatch-catchup.sql` | relation "public.cron_dispatch_state" does not exist |
| `deadline-locks.sql` | FAIL: new offers lock the next ET date: An identical offer is already pending. Open that trade instead. |
| `draft-timer-behavior.sql` | Only the commissioner can generate draft order. |
| `dynasty-rules.sql` | Only the commissioner can generate draft order. |
| `internal-scheduling-rls.sql` | relation "public.cron_dispatch_state" does not exist |
| `league-events-outcomes.sql` | FAIL: real trade execution enters the event log |
| `league-version-writes.sql` | propose trade: expected bump 1, before 13, after 13 |
| `live-ingestion-work.sql` | function invoke_live_poll_if_due() does not exist |
| `matchup-forecast-cache-parity.sql` | Required fixture parameters are absent |
| `notif-announcement-history.sql` | New membership reused former author request |
| `notif-draft-transitions.sql` | Only the commissioner can generate draft order. |
| `notif-pause-window.sql` | Only the commissioner can generate draft order. |
| `notification-waiver-outbox.sql` | function public.invoke_process_trades_if_due() does not exist |
| `per-minute-cron-gates.sql` | function public.invoke_close_expired_nominations_if_due() does not exist |
| `perf-beacons-validation.sql` | FAIL: existing retention job includes daily beacon pruning |
| `pg-net-response-vacuum.sql` | pg-net-response-vacuum is not scheduled |
| `picks-lifecycle.sql` | Only the commissioner can generate draft order. |
| `pre-tipoff-lineups.sql` | function public.invoke_pre_tipoff_optimizer_if_due() does not exist |
| `process-trades-gate.sql` | query returned no rows |
| `projection-sync-schedule.sql` | function private.claim_cron_dispatch(unknown, unknown) does not exist |
| `public-cli.sql` | Required league fixture is absent |
| `refresh-screen-cache.sql` | FAIL: member change advances version |
| `retention-pruning.sql` | FAIL: active high frequency job fixture exists |
| `rollover-year-gap.sql` | Only the commissioner can generate draft order. |
| `rookie-drafting-gate.sql` | relation "cron_dispatch_state" does not exist |
| `rules-faab-reservations.sql` | FAIL: a new offer cannot spend accepted FAAB: An identical offer is already pending. Open that trade instead. |
| `rules-reverse-standings-rates.sql` | Only the commissioner can generate draft order. |
| `server-deleted-league-notifications.sql` | function public.invoke_process_trades_if_due() does not exist |
| `server-game-progress-hints.sql` | A visible game change does not emit a hint |
| `server-injury-schedule.sql` | function public.invoke_edge_function_at_et_time(unknown, integer, integer, timestamp with time zone) does not exist |
| `server-injury-unavailable.sql` | relation "cron_dispatch_state" does not exist |
| `server-inventory-hint-cron.sql` | Inventory hints do not use the thirty second drain |
| `server-retired-picks.sql` | Only the commissioner can generate draft order. |
| `server-stopped-rookie-overflow.sql` | Only the commissioner can generate draft order. |
| `server-trade-window.sql` | function public.invoke_process_trades_if_due() does not exist |
| `taxi-acquisition-policy.sql` | Only the commissioner can generate draft order. |
| `timeline-lifecycle.sql` | FAIL: real actions recorded; missing: lineup.auto_set, scores.finalized, trade.accepted, trade.countered, trade.executed, trade.sent |
| `timeline-producers.sql` | FAIL: multi-team offer emits once |
| `trade-offer-retries.sql` | An identical offer is already pending. Open that trade instead. |
| `trade-propose-budget.sql` | Required fixture parameters are absent |
| `trade-value-readers.sql` | FAIL: recorded source player is matched |
| `trade-values.sql` | FAIL: all 450 players are stored |
| `waiver-backlog-behavior.sql` | Processor does not skip duplicate contended candidates |
| `weekly-idle-dispatch.sql` | function invoke_live_poll_if_due() does not exist |
| `weekly-idle-load.sql` | function invoke_live_poll_if_due() does not exist |
| `weekly-skip-idle.sql` | function invoke_live_poll_if_due() does not exist |
