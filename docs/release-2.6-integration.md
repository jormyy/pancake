# Release 2.6 integration evidence

The requested integration completes locally from `78c01b8c`.
All four requested commits enter in order.
Every integration commit includes `[skip ci]`.
No push, pull request, deployment, CI run, or production connection occurs.
The required checks pass.
Two additional database probes fail on both the candidate and the unchanged supplied baseline.
Those inherited failures remain outside this integration.

## Result counts

Counts from overlapping test scopes must not be added together.

| Check | Observed result |
| --- | --- |
| Full `npx vitest run` | 4,157 passed; 0 failed; 39 skipped. Files: 434 passed and 14 skipped. |
| `npm run test --workspace core` | 116 passed across 15 files; 0 failed; 0 skipped. |
| Focused season Vitest run | 31 passed across 5 files; 0 failed; 0 skipped. |
| Focused season cron run | 19 passed; 0 failed; 0 skipped. |
| `node --test scripts/season-sim/*.test.mjs` | 314 passed; 0 failed; 0 skipped. |
| Edge Deno suite | 514 passed with 16 steps; 0 failed; 16 ignored across 101 files. |
| `npm run check:quality` | All 13 chained checks pass, including lint and app, test, harness, and core type checks. |
| Edge inventory within quality | 22 function entrypoints and 61 checked Deno evidence entrypoints. |
| `npm run check:db-function-catalog` | Passes against all 625 private migrations; catalog contains 503 functions. |
| `npm run check:database-types` | Passes against all 625 private migrations. |
| Attestation check | Passes through `20261124000400`; 329 fixed baseline entries and 296 approved entries. |
| Migration collisions | 0; all four incoming versions stay unchanged. |
| Fresh versus incremental artifacts | 4 of 4 files match byte for byte. |
| SQL behavior checks | 215 counted assertions across 9 recipes, plus the retirement contract; all 10 recipes pass. |
| Real local handler chain | 14 checks pass through 18 local API requests; 18 picks, 3 trades, and 6 history records. |
| Additional inherited SQL probes | 2 fail on both 621-migration baseline and 625-migration candidate; details below. |
| Release delta | 4 new migrations and 5 changed Edge functions against `origin/main` at `78c01b8c`. |

## Merge and generated-file checks

| Step | Requested commit | Merge commit |
| --- | --- | --- |
| Replay classifier | `163d82ba` | `45adc611` |
| Vacuum cleanup and deadline | `4a2543f9` | `3069f52d` |
| Value-fetch retries | `87935656` | `dfd6bc62` |
| Trade scoring and pick predictions | `6a51f6da` | `622b8a26` |

The replay negative control runs the new classifier tests against the base implementation.
It produces 13 passes and one failure for the deferred-identity case.
The merged classifier passes all 14 tests under Node 22.
The dispatcher merge passes all 10 focused tests before its commit.
The retry merge passes 660 focused worker and attestation tests before its commit.
The final merge passes the full unit suite, quality checks, and generated-file checks before its commit.

Only the two attestation files have textual merge conflicts.
All four generated artifacts start from one side and then come from database generators.
No generated conflict receives a manual JSON or TypeScript edit.
The scheduler needs no textual conflict repair.
Its final definition keeps the 07:15 Eastern value schedule and league-local midnight waivers.
The final migration removes only the retired ranking scheduler call.
Retry claim release remains in `20261124000100`.
Successful publication queues pick predictions before trade re-analysis.

The private mini project is `pt4bafabler26`, with port block `586xx` and database port `58622`.
Source arrives through a Git bundle and an uncommitted merge patch.
Node dependencies come from the authorized local copy; no reinstall occurs.
The private configuration change stays outside Git commits.
Cron launch is disabled before behavior checks and rebuild comparisons.
The database first installs 621 migrations through `20261123000100`.
The four-file ordered suffix reaches 625 migrations.
A second baseline upgrade and a fresh 625-migration installation reproduce the same generated files.
Both attestations, the function catalog, and database types match byte for byte across all three runs.
The fixed audit anchor and recorded production security baseline remain unchanged.

## Database behavior

Recorded fixtures supply 450 players, with 445 matched identities and 5 review entries.
They also supply 18 source picks and 9 derived third-round bases.
No live provider request occurs.

| SQL recipe under `tests/db/` | Result |
| --- | ---: |
| `trade-values.sql` | 19 assertions pass. |
| `trade-values-retries.sql` | 36 assertions pass. |
| `trade-value-readers.sql` | 9 assertions pass. |
| `trade-estimate-reanalysis.sql` | 40 assertions pass. |
| `dynasty-ranking-metadata.sql` | Retirement response and no-write contract pass. |
| `work-queue-schedules.sql` | 40 assertions pass. |
| `work-queue-projections.sql` | 17 assertions pass. |
| `release25-values-and-schedules.sql` | 8 assertions pass. |
| `league-midnight-waivers.sql` | 43 assertions pass. |
| `waiver-timezone-change.sql` | 3 assertions pass. |

The local chain calls the real pick-prediction and trade-estimate handlers against the private database API.
Its fetch guard permits only `http://127.0.0.1:58621`.
It checks publication before prediction, then prediction before re-analysis.
The completion RPC rejects a premature request before every pick refresh finishes.
The worker rejects an unauthenticated request with HTTP 401.
It saves all 18 fixture picks with normalized odds and the current source hash.
Re-analysis processes pending, accepted, and completed fixture trades.
The database keeps one original and one converted history record per trade.
Replay processes zero trades and leaves all six history records unchanged.
The removed ranking work kind stays absent.
Private helper scripts and raw receipts stay outside the checkout in the owned mini folder.

## Inherited failures

These are additional probes beyond the requested passing checks.
Both reproduce using the original test files from `78c01b8c` against exactly 621 migrations through `20261123000100`.
The candidate produces the same failures after all four new migrations.
No product repair or expectation change hides either result.

| Probe | Observed failure |
| --- | --- |
| `tests/db/league-version-coverage.sql` | Reports uncovered `public.league_events` writes across existing RPC paths. |
| `tests/db/work-queue-lifecycle.sql` | Its dispatcher-only cron assertion rejects the existing `public-read-retention` schedule. |

The event-write coverage failure remains unresolved.
The dispatcher-only assertion omits a cron job already present in the baseline.
Neither failure starts with this integration.
A later repair must verify event invalidation and the intended complete cron set before changing either expectation.

## Commands and limits

Mac checks use Node 22.23.2.
The mini uses its scoped tools, Docker socket, and Node 22.23.3.
The local dependency symlink remains unchanged.

```sh
npx vitest run
npm run test --workspace core
npx vitest run tests/lib/season.test.ts tests/lib/player-season-averages.test.ts tests/app/player-browser-seasons.test.ts tests/components/player/season-data.test.ts tests/season-sim-cron.test.ts
node --test scripts/season-sim/cron.test.mjs scripts/season-sim/migration-cron.test.mjs scripts/season-sim/cron-dispatcher.test.mjs
node --test scripts/season-sim/*.test.mjs
npm run check:quality
node scripts/regenerate-release-history-attestations.mjs --check
```

The private mini runs these database and Edge checks.
`SUPABASE_DB_URL` names only loopback port `58622`.
`PANCAKE_TEST_DB_PORT` is `58622`.

```sh
supabase db reset --local --version 20261123000100 --no-seed
supabase migration up --local
node scripts/regenerate-release-history-attestations.mjs
npm run generate:db-function-catalog
npm run generate:database-types
npm run check:db-function-catalog
npm run check:database-types
supabase db reset --local --no-seed
deno test --cached-only --allow-env --allow-read --allow-net=127.0.0.1,localhost $(find supabase/functions -name '*.test.ts' -print)
```

SQL recipes use `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/<recipe>.sql`.
Behavior fixtures load before those recipes.
Artifact comparisons run after regeneration and before fixture loading.
Local helper scripts exercise the recorded source import and real handler chain.

The 39 skipped Vitest tests and 16 ignored Deno tests remain unexecuted coverage.
This integration does not run a release build, browser soak, full historical season replay, or live provider fetch.
It does not read a production backup or contact production, Vercel, or GitHub Actions.
It sends no real email or push notification.
No performance comparison runs, so this integration claims no measured speed or storage gain.
The private stack stops after final checks.
The next decision is a separate authorized rollout or repair of the inherited database probes.

## Changed files

All 100 files below differ from `78c01b8c`: 29 added, 54 modified, and 17 deleted.

| Change | File |
| --- | --- |
| M | `core/cjs/dynasty/decisionEngine.js` |
| A | `core/cjs/dynasty/tradeScoring.js` |
| M | `core/cjs/index.js` |
| M | `core/src/dynasty/decisionEngine.ts` |
| A | `core/src/dynasty/tradeScoring.ts` |
| M | `core/src/index.ts` |
| M | `core/tests/dynastyDecisionEngine.test.ts` |
| M | `docs/architecture.md` |
| M | `docs/io-audit.md` |
| M | `docs/production-migration-history.md` |
| A | `docs/release-2.6-integration.md` |
| M | `docs/release-history-attestations.md` |
| M | `docs/source-monitoring.md` |
| M | `docs/trade-estimates.md` |
| M | `docs/trade-values.md` |
| M | `knip.json` |
| M | `scripts/generate-edge-shared.mjs` |
| M | `scripts/season-sim/edge.mjs` |
| M | `scripts/season-sim/official-outcomes.mjs` |
| M | `scripts/season-sim/official-outcomes.test.mjs` |
| M | `supabase/RELEASE-DB.md` |
| M | `supabase/functions/_shared/dynastyEngine.ts` |
| A | `supabase/functions/_shared/dynastyEngineTradeValues.ts` |
| A | `supabase/functions/_shared/pickPredictionWork.ts` |
| A | `supabase/functions/_shared/pickPredictions.ts` |
| M | `supabase/functions/_shared/tradeEstimate.test.ts` |
| M | `supabase/functions/_shared/tradeEstimate.ts` |
| M | `supabase/functions/_shared/tradeValues.ts` |
| A | `supabase/functions/api/pickPredictionWork.test.ts` |
| A | `supabase/functions/api/pickPredictionWork.ts` |
| M | `supabase/functions/api/router.ts` |
| M | `supabase/functions/api/sync.ts` |
| M | `supabase/functions/api/tradeEstimateWork.test.ts` |
| M | `supabase/functions/api/tradeEstimateWork.ts` |
| M | `supabase/functions/api/tradeEstimates.ts` |
| M | `supabase/functions/dispatcher/postgres.ts` |
| D | `supabase/functions/sync-rankings/fixtures/dynasty-cards.html` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-manifest.json` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-point_3-1.html.gz` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-point_3-2.html.gz` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-point_5-1.html.gz` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-point_5-2.html.gz` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-rookie-1.html.gz` |
| D | `supabase/functions/sync-rankings/fixtures/rookies-2025-rookie-2.html.gz` |
| D | `supabase/functions/sync-rankings/form.test.ts` |
| D | `supabase/functions/sync-rankings/form.ts` |
| M | `supabase/functions/sync-rankings/index.ts` |
| D | `supabase/functions/sync-rankings/match.test.ts` |
| D | `supabase/functions/sync-rankings/match.ts` |
| D | `supabase/functions/sync-rankings/parser.test.ts` |
| D | `supabase/functions/sync-rankings/parser.ts` |
| D | `supabase/functions/sync-rankings/views.test.ts` |
| D | `supabase/functions/sync-rankings/views.ts` |
| M | `supabase/functions/sync-trade-values/index.ts` |
| A | `supabase/migrations/20261124000100_trade_value_fetch_retries.sql` |
| A | `supabase/migrations/20261124000200_trade_estimate_reanalysis.sql` |
| A | `supabase/migrations/20261124000300_trade_estimate_pick_inputs.sql` |
| A | `supabase/migrations/20261124000400_pick_predictions_and_ranking_cleanup.sql` |
| M | `supabase/sql/function-catalog.json` |
| M | `supabase/sql/functions/by-name/private/build_trade_estimate_inputs.sql` |
| D | `supabase/sql/functions/by-name/private/enqueue_rankings.sql` |
| M | `supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql` |
| M | `supabase/sql/functions/by-name/private/retain_trade_estimate_quotes.sql` |
| M | `supabase/sql/functions/by-name/public/claim_trade_value_sync.sql` |
| M | `supabase/sql/functions/by-name/public/cleanup_trade_estimate_quotes.sql` |
| A | `supabase/sql/functions/by-name/public/complete_pick_prediction_refresh.sql` |
| A | `supabase/sql/functions/by-name/public/fail_trade_value_sync.sql` |
| M | `supabase/sql/functions/by-name/public/get_dynasty_pick_values.sql` |
| A | `supabase/sql/functions/by-name/public/get_pick_prediction_inputs.sql` |
| A | `supabase/sql/functions/by-name/public/get_pick_prediction_leagues.sql` |
| A | `supabase/sql/functions/by-name/public/get_trade_estimate_reanalysis_batch.sql` |
| A | `supabase/sql/functions/by-name/public/get_trade_estimate_reanalysis_inputs.sql` |
| M | `supabase/sql/functions/by-name/public/publish_trade_values.sql` |
| A | `supabase/sql/functions/by-name/public/queue_trade_estimate_reanalysis.sql` |
| M | `supabase/sql/functions/by-name/public/replace_dynasty_rankings.sql` |
| A | `supabase/sql/functions/by-name/public/save_pick_predictions.sql` |
| A | `supabase/sql/functions/by-name/public/save_trade_estimate_reanalysis.sql` |
| M | `supabase/sql/functions/by-name/public/view_trade_details.sql` |
| A | `tests/__snapshots__/trade-scoring.test.ts.snap` |
| M | `tests/db/dynasty-ranking-metadata.sql` |
| M | `tests/db/league-version-coverage.sql` |
| A | `tests/db/trade-estimate-reanalysis.sql` |
| M | `tests/db/trade-value-readers.sql` |
| A | `tests/db/trade-values-retries.sql` |
| M | `tests/db/trade-values.sql` |
| M | `tests/db/work-queue-schedules.sql` |
| A | `tests/dispatcher-postgres.test.ts` |
| A | `tests/dispatcher-worker.test.ts` |
| M | `tests/e2e/configured-source-health.mjs` |
| M | `tests/e2e/db-security-catalog-attestations.json` |
| M | `tests/e2e/dynasty-ranking-rpc.mjs` |
| M | `tests/e2e/release-history-attestations.json` |
| M | `tests/e2e/source-failure-recovery.mjs` |
| M | `tests/e2e/surface-matrix.json` |
| A | `tests/e2e/trade-reanalysis-backup.mjs` |
| A | `tests/pick-predictions.test.ts` |
| A | `tests/trade-scoring.test.ts` |
| M | `tests/trade-value-readers.test.ts` |
| M | `tests/trade-values-worker.test.ts` |
| M | `types/database.ts` |
