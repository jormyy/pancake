# Release 2.14 integration

The branch starts at `c5789474`, release 2.13.1.
It merges realtime `2cb3acc5`, Home recovery `50aa8bd4`, workers `cebdf3bc`, then pre-tipoff fix `bf84d604` in that order.
The workers merge is `b4c2b753`. The pre-tipoff merge is `752150cd`. All release commits use `[skip ci]`.
The orchestrator ships. This work does not push, open a PR, deploy or run CI.
No production service is contacted.

The private project is `pt4bafableint`, Docker Desktop context `desktop-linux`, ports `650xx`.
Node is 22.23.2. SQL recipes use PostgreSQL client 16 against local PostgreSQL 17.
The stack config lives under `/tmp/pancake-int214/stack`.
Repository `supabase/config.toml` stays unchanged.
Cron and HTTP delivery are disabled. A queue trigger rejects external HTTP.
Reapply those settings after a reset, which restores server defaults.
The automation browser uses independent synthetic sessions and a local domain allowlist.

## Database comparison

Production head `20261214005409` contains 729 migrations.
The candidate contains 737 migrations through `20261214005500`.
Seven pending migrations have earlier version numbers. Apply all eight with `--include-all`:

1. `20261214004000_live_broadcast.sql`
2. `20261214004010_coalesce_live_hints.sql`
3. `20261214004200_bound_cron_history_batches.sql`
4. `20261214004300_start_work_invocation.sql`
5. `20261214004400_coalesce_invocation_reconciliation.sql`
6. `20261214004500_batch_trade_refresh_checks.sql`
7. `20261214004600_gate_unchanged_trade_scans.sql`
8. `20261214005500_pre_tipoff_member_failures.sql`

The ordered-upgrade stack resets against the exact migration tree from `c5789474`.
The normal migration runner then applies the eight missing versions in order.
The independent fresh reset applies all 737 repository migrations from scratch.
Both attestations, the function catalog, database types and public/private schema match byte for byte.
The captured `private.work_claim` definition also matches in both catalogs and the production baseline.
Its canonical source blob remains `34859f45db3cfecc9d3282be16e139d4ebde39b8`.
Main's migrations 05406–05408 retain their claim order.

Both attestations are regenerated from local metadata. Neither is merged by hand.
The audit anchor, historical aliases and recorded pre-migration catalog stay unchanged.
The actual migration-runner upgrade seeds 330 pending checks, 41 scans and eight valuations.
All twenty assertions pass after the actual eight-migration upgrade, including 04500 and 04600.
One full scan replaces pending checks and duplicate scans. Existing valuations remain byte-identical.
Failed retries, earlier attempt evidence, running work and locked-row compatibility remain covered.
The standalone rollback proof passes the same twenty assertions.

## Pre-tipoff verification

The new migration adds `public.record_pre_tipoff_lineup_failure` and nullable member error receipts.
The function catalog, both attestations and database types are regenerated from each local catalog.
The audit anchor, aliases and recorded production catalog also match main after regeneration.
The SQL receipt proof passes all 18 assertions. Trade-lock coverage passes all 29.
The refreshed work-queue and roster fixtures pass, as do all four fixed SQL regressions.
The standalone trade-revaluation upgrade proof passes 20 assertions.
Together with retained Taxi auction coverage, the focused SQL sweep passes 10 recipes with zero failures.
The supplied pre-existing Taxi failure remains recorded; it is not deleted or counted as a new regression.

`preTipoff.test.ts` passes 22 Deno tests with cached imports and loopback-only access.
`pre-tipoff-trade-offer.ts` passes four cases through the real handler and four through the local Edge runtime.
Healthy no-offer and pending-offer responses keep their exact bytes.
One bad member receives a durable error while healthy members finish in one successful work attempt.
The 103-member case records 102 successes and one failure without a retry.
The live-score concurrency proof passes its overlapping writes, league/settings locks, scoring and stable retry assertions.
The owned Edge runtime and gateway stop after the proof. No paired realtime capture is restarted.

## Retained verification

The workers recipe runs all nineteen SQL files listed in `docs/perf-l4.md`.
All nineteen pass. All four fixed SQL regressions also pass.
Taxi auction passes on this empty local schema. The supplied pre-existing failure remains recorded and its test stays.
The SQL sweep totals 24 passing recipes and zero failures.
The six trade mutation controls reject their named broken behaviors.
All four Deno completion-call tests pass with cached imports and loopback-only network access.
Deno checks the shared invocation wrapper and refresh worker with remote imports disabled.
The new leased-start RPC and finish receipt also pass through real local PostgREST with its API session guard.
Temporary HTTP-probe fixtures are removed.

The combined-source realtime verifier passes all twelve steps.
All seven surfaces update on two independent browser sessions without reloading their documents.
Unmodified releases 2.9.1, 2.10.2, 2.11 and 2.11.1 update beside Broadcast.
The 16-table writer and topic-authorization checks, three-season SQL replay and message retention probe pass.
The lane's existing paired measurements establish the realtime gains.
The partial integration captures ended before completion and establish no new gain.
Release verification keeps the passed delivery, legacy-client and twelve-step correctness checks.
The paired capture windows are not restarted.

The targeted workers and release-order Vitest selection passes 32 tests across two files.
The earlier ready-lane selection passes 92 tests across seven files.
The final combined gate runs application, test and e2e typechecks, full lint, Knip,
SQL source parity, live function catalog parity, database types, attestation validation and full Vitest.
Full Vitest runs once on the final commit. Its actual counts are reported in the release handoff.
Logs remain outside Git under `/tmp/pancake-int214/r2142` and `/tmp/pancake-int214/r2143`.

## Changed release surfaces

Client source changes relative to `c5789474` are:

- `lib/realtime.ts`
- `lib/cache/screen-cache.ts`
- `hooks/use-live-view-recovery.ts`
- `hooks/use-screen-view.ts`
- `types/database.ts`, generated for startup and member-failure RPCs and the nullable receipt error

The direct Edge implementation changes are `_shared/syncRuns.ts`, `refresh-views/work.ts`,
`lineup-optimizer/index.ts` and `lineup-optimizer/preTipoff.ts`.
The shared invocation wrapper affects API trade-work routes and twenty internal entry points.
The affected deployable functions are `api`, `close-expired-nominations`, `dispatcher`, `lineup-optimizer`,
`live-poll`, `matchup-forecast`, `process-trades`, `process-waivers`, `refresh-views`, `season-boundary`,
`sync-draft-order`, `sync-player-injuries`, `sync-players`, `sync-projections`, `sync-rankings`,
`sync-schedule`, `sync-scores`, `sync-sleeper-projections`, `sync-stats`, `sync-trade-values` and `verify`.
Apply SQL first. Migration 04300 precedes the shared wrapper; 04600 precedes the refresh model field;
05500 precedes the updated lineup optimizer.
Keep the 16-table legacy publication during the frontend transition.

Integration adds no product fix beyond the authorized lanes and no dependency changes.
The local Auth issuer is aligned with the HTTPS harness address.
Mac copy-on-write clones keep the installed workspace modules inside each Metro checkout.
The first HTTP-probe cleanup query used a nonexistent column; the corrected probe and cleanup pass.
[Cleanup accounting](release-2.14-cleanup.md) lists removed paths, byte sizes, retained coverage and commit line counts.
[Realtime](perf-l1.md), [workers](perf-l4.md), [Home recovery](../tests/e2e/pwa-live-game.md)
and [pre-tipoff](pre-tipoff-trade-offer-fix.md) retain one summary per lane.
Stop the owned runtime and stack through Supabase after final verification.
