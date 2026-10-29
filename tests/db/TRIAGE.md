# SQL recipe triage

## Scope and baseline

Baseline: `8cbaee99`, release 2.6.3.
The private stack applies all 628 migrations through `20261130000100`.
The sweep inventories 300 original SQL files and nine included fragments.
It runs 294 cases, including three calendar modes and two notification modes.
The recorded sweep has 238 passes and 56 failures.
The earlier repair report lists 47 inherited failures; its snapshot contains one more SQL recipe.
The lock harness already passes the inherited waiver backlog check.
The standalone fixture fails without its required held lock.
The slow retired load test exceeds 80 seconds and leaves database work running.
That work causes two lock failures before its private database sessions are stopped.
The interrupted gate check is rerun in the final sweep.
No production system, restored backup, external delivery, or CI supplies this evidence.

## Trade proposal first

Classification: **STALE**.
Migration `20261116000500` defers trade events, versions, and screen refresh work.
The parent checks the version before its durable publication runs.
The exact failing statement is:

```sql
CALL pg_temp.version_write('propose trade',$cmd$UPDATE version_fixture SET trade_id=public.propose_trade_atomic(league_id,season_id,member_ids[1],member_ids[2],ARRAY[players[1]],ARRAY[players[2]],'{}','{}')$cmd$);
```

The error is `propose trade: expected bump 1, before 13, after 13`.
The parent now commits, publishes saved trade changes, and checks the committed version.
Its five included fragments execute; the parent proves 126 committed writes.
The swap fixture uses its two intended players to avoid random ownership changes.

## All 47 inherited failures

The first-error column preserves the earlier report when a full fixture cannot reach the retired call.
The next table records additional errors observed on this checkout.

| Recipe | First failing assertion or error | Class | Action |
| --- | --- | --- | --- |
| `correlated-dispatch.sql` | function public.invoke_edge_function_at_et_time(unknown, integer, integer) does not exist | STALE | Delete the retired scheduler recipe. `work-queue-schedules.sql` covers its queue replacement. |
| `cron-dispatch-catchup.sql` | relation "public.cron_dispatch_state" does not exist | STALE | Delete the retired scheduler recipe. `work-queue-schedules.sql` covers its queue replacement. |
| `deadline-locks.sql` | FAIL: new offers lock the next ET date: An identical offer is already pending. Open that trade instead. | STALE | Withdraw the matching offer before testing the deadline guard. |
| `draft-timer-behavior.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity. Check the dispatcher schedule. |
| `dynasty-rules.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity. Use descending points for tied draft records. Allow seeded ties. |
| `internal-scheduling-rls.sql` | relation "public.cron_dispatch_state" does not exist | STALE | Delete the retired scheduler recipe. `work-queue-lifecycle.sql` covers its queue replacement. |
| `league-events-outcomes.sql` | FAIL: real trade execution enters the event log | STALE | Drain saved trade publications. Use the member lineup API for member events. |
| `league-version-writes.sql` | propose trade: expected bump 1, before 13, after 13 | STALE | Check versions after committed trade publication. Limit swap fixtures to their two intended players. |
| `live-ingestion-work.sql` | function invoke_live_poll_if_due() does not exist | STALE | Delete the retired scheduler recipe. `work-queue-live-poll.sql` covers its queue replacement. |
| `matchup-forecast-cache-parity.sql` | Required fixture parameters are absent | STALE | Build a private matchup with full rosters and historical appearances when no matchup is supplied. |
| `notif-announcement-history.sql` | New membership reused former author request | STALE | Expect the same user request to replay its saved result. Preserve the former author. |
| `notif-draft-transitions.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity. Make old clock notices due before testing stale suppression. |
| `notif-pause-window.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity before starting each draft. |
| `notification-waiver-outbox.sql` | function public.invoke_process_trades_if_due() does not exist | STALE | Use queued trade work. Give each notification scenario its own queue state. |
| `per-minute-cron-gates.sql` | function public.invoke_close_expired_nominations_if_due() does not exist | STALE | Delete the retired scheduler recipe. `work-queue-gates.sql` covers its queue replacement. |
| `perf-beacons-validation.sql` | FAIL: existing retention job includes daily beacon pruning | STALE | Check daily retention work instead of a removed cron entry. |
| `pg-net-response-vacuum.sql` | pg-net-response-vacuum is not scheduled | STALE | Check queued hourly maintenance. Execute the dispatcher vacuum command and retain the page-reuse proof. |
| `picks-lifecycle.sql` | Only the commissioner can generate draft order. | STALE | Set draft identity and the snake option. Use descending points. Clear identity before trusted server calls. |
| `pre-tipoff-lineups.sql` | function public.invoke_pre_tipoff_optimizer_if_due() does not exist | STALE | Delete the retired scheduler recipe. `work-queue-pre-tipoff.sql` covers its queue replacement. |
| `process-trades-gate.sql` | query returned no rows | STALE | Delete the retired scheduler recipe. `work-queue-trades.sql` covers its queue replacement. |
| `projection-sync-schedule.sql` | function private.claim_cron_dispatch(unknown, unknown) does not exist | STALE | Delete the retired scheduler recipe. `work-queue-projections.sql` covers its queue replacement. |
| `public-cli.sql` | Required league fixture is absent | STALE | Create a private league, season, members, and player instead of requiring a backup. |
| `refresh-screen-cache.sql` | FAIL: member change advances version | STALE | Test clean-to-dirty versions, partial publication, five-second continuation, and isolated queue claims. |
| `retention-pruning.sql` | FAIL: active high frequency job fixture exists | STALE | Attach the high-frequency history fixture to the current dispatcher job. |
| `rollover-year-gap.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity before draft creation. |
| `rookie-drafting-gate.sql` | relation "cron_dispatch_state" does not exist | STALE | Delete the retired scheduler recipe. `work-queue-schedules.sql` covers its queue replacement. |
| `rules-faab-reservations.sql` | FAIL: a new offer cannot spend accepted FAAB: An identical offer is already pending. Open that trade instead. | STALE | Use distinct offer amounts so pending-offer detection does not mask balance checks. |
| `rules-reverse-standings-rates.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity. Distinguish waiver ordering from the current draft tie rule. |
| `server-deleted-league-notifications.sql` | function public.invoke_process_trades_if_due() does not exist | STALE | Use an isolated due-work queue. Keep deletion suppression and receipt checks. |
| `server-game-progress-hints.sql` | A visible game change does not emit a hint | STALE | Check one hint per transaction with the required date scope. |
| `server-injury-schedule.sql` | function public.invoke_edge_function_at_et_time(unknown, integer, integer, timestamp with time zone) does not exist | STALE | Delete the retired scheduler recipe. `work-queue-schedules.sql` covers its queue replacement. |
| `server-injury-unavailable.sql` | relation "cron_dispatch_state" does not exist | STALE | Delete the retired scheduler recipe. `work-queue-lifecycle.sql` covers its queue replacement. |
| `server-inventory-hint-cron.sql` | Inventory hints do not use the thirty second drain | STALE | Check the shared thirty-second drain and its combined command. |
| `server-retired-picks.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity before both draft starts. |
| `server-stopped-rookie-overflow.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity before draft creation. |
| `server-trade-window.sql` | function public.invoke_process_trades_if_due() does not exist | STALE | Use queued work. Withdraw matching offers while testing proposal guards. |
| `taxi-acquisition-policy.sql` | Only the commissioner can generate draft order. | STALE | Set the commissioner identity before both draft starts. |
| `timeline-lifecycle.sql` | FAIL: real actions recorded; missing: lineup.auto_set, scores.finalized, trade.accepted, trade.countered, trade.executed, trade.sent | STALE | Publish deferred trades. Use the member lineup API for its timeline event. |
| `timeline-producers.sql` | FAIL: multi-team offer emits once | STALE | Drain trade publications before checking events and settings. |
| `trade-offer-retries.sql` | An identical offer is already pending. Open that trade instead. | BUG | Update pending-offer and global receipt rules. Move the valid former-owner assertion to its minimal bug reproduction. |
| `trade-propose-budget.sql` | Required fixture parameters are absent | STALE | Create ten teams, full rosters, and more than 200000 game-stat rows. Keep the five-second budget. |
| `trade-value-readers.sql` | FAIL: recorded source player is matched | STALE | Load the recorded source into a rolled-back private fixture. |
| `trade-values.sql` | FAIL: all 450 players are stored | STALE | Load all 450 recorded players and 18 picks before testing publication. |
| `waiver-backlog-behavior.sql` | Processor does not skip duplicate contended candidates | STALE | Run the existing lock harness instead of executing its fixture alone. |
| `weekly-idle-dispatch.sql` | function invoke_live_poll_if_due() does not exist | STALE | Delete the retired scheduler recipe. `work-queue-weekly-scoring.sql` covers its queue replacement. |
| `weekly-idle-load.sql` | Local run exceeds 80 seconds during setup; the earlier sweep reaches removed `invoke_live_poll_if_due()`. | STALE | Delete the retired scheduler recipe. `work-queue-weekly-scoring.sql` covers its queue replacement. |
| `weekly-skip-idle.sql` | Local run hits a lock timeout after the load test; the earlier sweep reaches removed `invoke_live_poll_if_due()`. | STALE | Delete the retired scheduler recipe. `work-queue-weekly-scoring.sql` covers its queue replacement. |

All 14 deleted recipes appear above with their replacement and reason.
The remaining inherited recipes stay in the retained sweep or run through their required parent.

## Additional observed failures

| Recipe | First observed failure | Class | Action |
| --- | --- | --- | --- |
| `league-version-coverage.sql` | Uncovered screen writes: 21 RPC paths reach public.league_events without version capture. | BUG | Move league-event coverage to the failing minimal reproduction. Keep all other catalog checks. |
| `release2-standings-dispatch.sql` |  FAIL: only the minute dispatcher owns scheduling | BUG | Move sole-dispatcher ownership to the cron reproduction. Retain standings dispatch and publication checks. |
| `release25-values-and-schedules.sql` |  FAIL: compact profile includes the stored trade value | STALE | Keep calculator values out of player profiles. Retain schedule and profile-section checks. |
| `retention-daily.sql` |  FAIL: public.league_change_hints cumulative summary matches both bounded prunes | STALE | Reset accumulated retention counters before measuring this fixture. Track the separate cron bug. |
| `retention-queue.sql` |  FAIL: retention and views share the sole dispatcher cron entry | BUG | Track the extra cron job in the minimal reproduction. Retain retention execution checks. |
| `screen-publication-versions.sql` |  Use the private screen test database. | STALE | Read the private port from the supplied test environment. |
| `work-queue-forecasts.sql` |  canceling statement due to lock timeout | STALE | Run after stopping the timed-out load fixture. The unchanged recipe passes. |
| `work-queue-gates.sql` | Connection closes when the blocked private test session is stopped. | STALE | Rerun the interrupted check. The unchanged recipe passes. |
| `work-queue-lifecycle.sql` |  FAIL: only the dispatcher is scheduled | BUG | Track the extra cron job in the minimal reproduction. Retain lifecycle and authorization checks. |
| `work-queue-views.sql` |  FAIL: view refresh adds no second cron entry | BUG | Track the extra cron job in the minimal reproduction. Retain view queue checks. |
| `roster-lifecycle-oracle.sql` | I1 reports a stale listing after moving its player to IR. | STALE | Keep listing ownership checks. Current listings survive IR and taxi moves; reads apply the league policy. |

## Product bugs

These assertions remain valid. Product files stay unchanged.
Run each reproduction directly with `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f <path>`.
Each currently exits 3 with its exact `BUG:` error.

| Bug | Reproduction | Exact error |
| --- | --- | --- |
| league-version-coverage.sql | `tests/db/regressions/league-event-version.sql` | `BUG: a league event does not advance its screen version` |
| release2-standings-dispatch.sql, retention-daily.sql, retention-queue.sql, work-queue-lifecycle.sql, work-queue-views.sql | `tests/db/regressions/dispatcher-cron-ownership.sql` | `BUG: public-read-retention bypasses the work dispatcher` |
| trade-offer-retries.sql | `tests/db/regressions/trade-receipt-former-owner.sql` | `BUG: a former owner replays a trade receipt without membership` |

`known-bugs.json` records every moved assertion and its normal recipe.
The normal catalog excludes league events only because their valid assertion runs in the mandatory bug checks.
The five sole-dispatcher checks allow the reported extra cron job while the mandatory reproduction detects it.
The valid former-owner assertion moves out of the large retry recipe into its mandatory minimal reproduction.
`npm run test:db:bugs` requires exactly the recorded failure for every reproduction.
It fails on an unrelated error or when a defect is fixed.
A fixed defect therefore requires restoring its ordinary assertion and removing its expected failure entry.

## Runner and evidence

`npm run test:db` discovers every retained top-level SQL recipe.
Included SQL fragments run through their parents.
Calendar and notification variants remain explicit.
The waiver backlog fixture runs through its existing held-lock harness.
The ten established pick and player recipes keep their existing commands.
The existing pick fixture harness also runs.
The former broader API and ingestion chain remains available as `npm run test:db:integration`.
The SQL sweep requires only private loopback targets matching this checkout.
The benchmark builds more than 200000 game-stat rows and rolls them back.
The recorded trade-value fixture also rolls back.
No installed packages or private environment files change.

The full retained sweep passes 280 cases in 87.148 seconds.
All three product bug reproductions retain their exact failures.
Quality checks pass with Node 22.

Final measurements appear in [verification.md](../../docs/verification.md#database-recipe-triage).
