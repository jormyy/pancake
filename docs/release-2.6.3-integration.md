# Release 2.6.3 integration

## Result

The integration starts at `045f2d09`.
It merges Hashtag restoration before player read performance.
The final dynasty reader uses Hashtag sources and computes fantasy averages once per read.
OneNumberHoops stays limited to trade calculations.
Future picks keep the original release 2.4 curve.

The first merge is `e1fa1c5c`.
The second merge is `a4ddd728`.
Every integration commit includes `[skip ci]`.
The [release contract](../supabase/RELEASE-DB.md#release-263) owns rollout and rollback.
Only `sync-rankings` changes against `origin/main` at `045f2d09`.
The restored function requires deployment.

## Database evidence

The private mini project is `pt4bafabler263`, with ports `592xx`.
Cron launch is disabled for the ordered upgrade and behavior checks.
The ordered upgrade first applies all 626 migrations through `20261128000100`.
It then applies `20261129000100` and `20261130000100` in that order.
The resulting history contains 628 migrations.
An ordered upgrade and a fresh 628-migration install produce identical bytes for all four generated artifacts.
Both attestations, the function catalog, and database types regenerate from that database.
No generated file receives a manual edit.
The generated types remain unchanged.
The function catalog restores two private helpers.
The audit anchor, historical aliases, and recorded security baseline stay unchanged.

| Check | Result |
| --- | --- |
| `npm run generate:db-function-catalog` | Pass. |
| `npm run generate:database-types` | Pass; unchanged bytes. |
| `node scripts/regenerate-release-history-attestations.mjs` | Pass; 628 migrations through `20261130000100`. |
| `npm run check:db-function-catalog` | Pass against the private database. |
| `npm run check:database-types` | Pass against the private database. |
| `node scripts/regenerate-release-history-attestations.mjs --check` | Pass. |

## Tests

Mac checks use Node 22.23.2 and the existing dependency symlink.
The mini uses Node 22.23.3 and Deno 2.7.14.
Database and Edge tests run only on the mini.

| Command or scope | Result |
| --- | --- |
| `PLAYER_PAGE_EVIDENCE=<paired.json> npx vitest run --maxWorkers=2` | 4,202 passed; zero failed; 39 skipped. Files: 436 passed; 14 skipped. |
| Edge Deno tests, all 108 files | 538 passed; 16 steps passed; zero failed; 17 ignored. |
| `node --test scripts/season-sim/*.test.mjs` | 314 passed; zero failed; zero skipped. |
| `npm run test --workspace core` | 116 passed across 15 files; zero failed. |
| Focused season tests, five files | 31 passed; zero failed. |
| `npm run check:quality` | Pass; all 13 configured checks complete. |
| Release compatibility, history, security, and head tests | 728 passed across four files; zero failed. |
| Captured performance and snapshot tests | 25 passed; zero failed. |
| `tests/db/dynasty-ranking-metadata.sql` | Pass; metadata writes and invalid metadata rejection. |
| `tests/db/hashtag-ranking-restoration.sql` | 11 checks passed after both migrations. |
| `tests/db/dynasty-decision-inputs.sql` | Pass; ranks, hot read, search, authorization, and anonymous denial. |
| `tests/db/trade-value-readers.sql` | Nine checks passed. |
| `tests/db/work-queue-schedules.sql` | 44 checks passed. |
| Hashtag worker and authenticated player routes | Both complete checks pass. |

The worker writes 400 five-year rows, 400 three-year rows, and 52 rookie rows.
All 450 OneNumberHoops player rows and 27 pick bands stay intact.
Trade publication preserves Hashtag screen ranks.
The player routes return both Hashtag point forecasts.

The focused season command covers these five files:

```sh
npx vitest run tests/lib/season.test.ts tests/lib/player-season-averages.test.ts tests/app/player-browser-seasons.test.ts tests/components/player/season-data.test.ts tests/season-sim-cron.test.ts
```

The mini runs all Edge tests with cached dependencies and loopback network access:

```sh
deno test --cached-only --allow-env --allow-read --allow-net=127.0.0.1,localhost $(find supabase/functions -name '*.test.ts' -print)
```

## Measured performance

This integration uses synthetic data only.
The fixture adds 600 players and 38,400 game lines across two seasons.
The selected member has 25 roster players and ten starting slots.
The home response includes a matchup.
Both projection and dynasty responses contain 600 players.

The comparison reinstates the Hashtag reader from `30a5b2a0` inside a transaction.
It then applies the combined performance migration and repeats the same reads before rollback.
Each of five functions gets three warmups and 20 measured executions before and after.
The comparison contains 200 measured executions and 18 complete JSON snapshot pairs.
All 18 pairs match.
Times are PostgreSQL execution times from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
The p95 uses sorted sample 19 of 20.

| Function | Before p95 ms | After p95 ms |
| --- | ---: | ---: |
| Player overview | 7.834 | 8.391 |
| Full player | 14.951 | 16.225 |
| League projections | 28.564 | 28.728 |
| Dynasty forecast inputs | 53.124 | 38.458 |
| Home | 6.234 | 5.943 |

Dynasty p95 falls 27.6% on this synthetic fixture.
Its final shared-hit sample rises from 5,854 to 7,542.
Every final sample reads zero shared blocks from disk.
These results do not measure production load or reproduce the earlier branch's larger restored-data benchmark.
[Database health](db-health.md) retains that earlier study separately.

## Negative controls

The unreconciled performance migration fails the combined Hashtag source assertion.
The corrected migration passes all 11 combined checks.
A changed real overview snapshot causes exactly one expected test failure; the other 24 pass.
The original captured evidence then passes all 25 tests.
Stale attestations fail before regeneration.
The regenerated attestations pass the complete suite.
The restored HTML fixture retains captured whitespace from the incoming branch.
New integration changes pass `git diff --check`.

## Limits

No production service, hosted deployment, CI, real email, or push service receives a request.
No branch is pushed and no pull request opens.
Browser checks and a release build do not run in this integration.
The private stack stops after verification.
The local dependency symlink stays unchanged.

## Changed files

The list below covers every file changed against `045f2d09`.
`types/database.ts` regenerates with identical bytes and therefore does not appear.

Total: 55 changed files.

```text
components/player/PlayerHeader.tsx
docs/db-health.md
docs/dynasty-rankings-restoration.md
docs/production-migration-history.md
docs/release-2.6.3-integration.md
docs/trade-values.md
hooks/use-dynasty-rankings.ts
lib/dynasty-decisions.ts
lib/dynasty-ranking-values.ts
supabase/RELEASE-DB.md
supabase/functions/sync-rankings/fixtures/dynasty-cards.html
supabase/functions/sync-rankings/fixtures/rookies-2025-manifest.json
supabase/functions/sync-rankings/fixtures/rookies-2025-point_3-1.html.gz
supabase/functions/sync-rankings/fixtures/rookies-2025-point_3-2.html.gz
supabase/functions/sync-rankings/fixtures/rookies-2025-point_5-1.html.gz
supabase/functions/sync-rankings/fixtures/rookies-2025-point_5-2.html.gz
supabase/functions/sync-rankings/fixtures/rookies-2025-rookie-1.html.gz
supabase/functions/sync-rankings/fixtures/rookies-2025-rookie-2.html.gz
supabase/functions/sync-rankings/form.test.ts
supabase/functions/sync-rankings/form.ts
supabase/functions/sync-rankings/index.ts
supabase/functions/sync-rankings/match.test.ts
supabase/functions/sync-rankings/match.ts
supabase/functions/sync-rankings/parser.test.ts
supabase/functions/sync-rankings/parser.ts
supabase/functions/sync-rankings/views.test.ts
supabase/functions/sync-rankings/views.ts
supabase/migrations/20261129000100_restore_hashtag_rankings.sql
supabase/migrations/20261130000100_player_page_speed.sql
supabase/sql/function-catalog.json
supabase/sql/functions/by-name/private/build_trade_estimate_inputs.sql
supabase/sql/functions/by-name/private/enqueue_rankings.sql
supabase/sql/functions/by-name/private/enqueue_scheduled_work.sql
supabase/sql/functions/by-name/private/trade_value_player_inputs.sql
supabase/sql/functions/by-name/public/get_dynasty_forecast_inputs.sql
supabase/sql/functions/by-name/public/get_trade_estimate_reanalysis_inputs.sql
supabase/sql/functions/by-name/public/publish_trade_values.sql
supabase/sql/functions/by-name/public/replace_dynasty_rankings.sql
supabase/sql/functions/by-name/public/resolve_trade_value_review.sql
supabase/sql/functions/by-name/public/view_draft_room.sql
supabase/sql/functions/by-name/public/view_player.sql
tests/components/player/player-detail.test.ts
tests/db/dynasty-ranking-metadata.sql
tests/db/hashtag-ranking-restoration.sql
tests/db/player-page-performance.mjs
tests/db/player-page-performance.test.ts
tests/db/trade-value-readers.sql
tests/db/work-queue-schedules.sql
tests/e2e/db-security-catalog-attestations.json
tests/e2e/dynasty-ranking-rpc.mjs
tests/e2e/hashtag-rankings-browser.mjs
tests/e2e/release-history-attestations.json
tests/hooks/dynasty-rankings-identity.test.ts
tests/lib/dynasty-ranking-values.test.ts
tests/release-edge-compatibility.test.ts
```
