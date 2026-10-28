# Database health

## Player reads: 2026-10-28 baseline

The private mini uses project `pt4bafablepp` and database port `59122`.
The schema comes from release 2.6.2 at `045f2d09`.
The data comes from the 2026-10-28 production backup.
The restore excludes a removed dispatch table and incompatible storage metadata.
The tested tables contain 2,618 players, 245,097 game lines, and 3,817 season totals.
The selected real member has 25 roster players.
The home response includes a matchup and ten starting slots.
The projection response includes 461 players.
The dynasty response includes 404 players.
Background jobs stay disabled throughout this work.
No production service receives a request.

Each function gets three warmups and 20 measured executions in one transaction.
Each measurement uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` as `authenticated` with the member's user claim.
Percentiles use nearest ranks: sorted samples 10 and 19.
Times below use PostgreSQL execution time in milliseconds.
Every final sample reads zero shared blocks from disk.
The JIT setting stays enabled with default thresholds.
However, `pg_jit_available()` returns false on the mini image.
This test cannot measure production JIT costs.
These quiet mini measurements do not reproduce the reported production latency.
Production load and hardware differ; this test cannot assign their separate costs.

| Function | p50 ms | p95 ms | Shared hits |
| --- | ---: | ---: | ---: |
| view_player, overview | 6.216 | 6.858 | 493 |
| view_player, full | 10.805 | 11.060 | 932 |
| get_league_projection_rows | 63.212 | 65.861 | 19,923 |
| get_dynasty_forecast_inputs | 266.269 | 274.467 | 47,815 |
| view_home | 5.478 | 6.382 | 636 |

Nested plans expose a repeated dynasty join over season fantasy averages.
The join scans 411 season totals for each of 404 players.
One traced execution spends 235 ms before it joins projections.
The projection plan also repeats scans of materialized player lists.

Run `node tests/db/player-page-performance.mjs --output <private-output.json>` on this isolated database.
Set `SUPABASE_DB_URL` to its loopback connection and `PANCAKE_TEST_DB_PORT=59122`.
The recipe requires loopback and the configured local database port.
Raw snapshots contain restored data and stay outside the repository.
Run `PLAYER_PAGE_EVIDENCE=<private-output.json> npx vitest run tests/db/player-page-performance.test.ts` to check captured evidence.

### Change 1: compute dynasty fantasy averages once

The dynasty function now materializes fantasy averages for the requested league and season.
It joins those rows to the selected players once.
No index or security rule changes.
The paired run uses one transaction, so both snapshots share the same clock and data.
All 18 complete JSON snapshots match.

| Function | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| view_player, overview | 6.214 | 7.062 | 6.368 | 7.948 |
| view_player, full | 10.641 | 11.285 | 10.560 | 10.815 |
| get_league_projection_rows | 63.087 | 67.470 | 63.863 | 66.424 |
| get_dynasty_forecast_inputs | 267.881 | 278.992 | 52.565 | 57.235 |
| view_home | 5.517 | 6.496 | 5.550 | 5.809 |

Dynasty p95 falls 79.5%; shared hits fall from 47,815 to 18,396.
Other functions show timing noise; their plans stay unchanged.
The dynasty SQL recipe passes, including authorization checks.
The captured evidence passes 24 tests; nine related tests also pass.
Catalog, types, and migration attestations regenerate successfully.
Catalog and source parity checks pass.

### Rejected projection experiments

Inlining the shared player list increases repeated table reads.
Its projection p95 rises from 68.166 ms to 86.844 ms.
Its dynasty p95 rises from 55.503 ms to 57.268 ms.
Its overview p95 rises from 7.730 ms to 7.979 ms.
Its full player p95 rises from 11.282 ms to 12.826 ms.
Its home p95 moves from 6.445 ms to 5.854 ms without a plan change.
The experiment is reverted.

Materializing the Sleeper schedule cuts projection shared hits from 19,923 to 9,048.
Its projection p95 still rises from 64.639 ms to 66.232 ms.
Its dynasty p95 stays near 52.74 ms.
Its overview p95 rises from 6.888 ms to 7.957 ms.
Its full player p95 moves from 12.923 ms to 11.040 ms.
Its home p95 moves from 6.199 ms to 5.960 ms without a plan change.
This experiment is also reverted because latency does not improve.
No index is added.
The retained change only rewrites the dynasty function.

### Final paired measurements

The final comparison reinstates the original dynasty source inside a transaction.
It then applies migration `20261130000100` and repeats all measurements before rollback.
All 18 full JSON snapshots match.
They cover player sections, historical seasons, projection modes, pagination, search, authorization, and populated home lineups.
Every function gets 20 measured warm executions before and after.

| Function | Before p50 | Before p95 | After p50 | After p95 | Target p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| view_player, overview | 6.226 | 7.057 | 6.144 | 6.275 | 300 |
| view_player, full | 10.602 | 11.052 | 10.678 | 10.960 | 300 |
| get_league_projection_rows | 63.026 | 65.442 | 63.836 | 68.825 | 500 |
| get_dynasty_forecast_inputs | 267.038 | 277.629 | 52.205 | 53.603 | — |
| view_home | 5.594 | 6.490 | 5.707 | 7.324 | 300 |

Dynasty p95 falls 80.7% in the final paired run.
Shared hits fall from 47,855 to 18,436.
The other functions keep their original plans and shared-hit counts.
Their small timing changes are noise.
All required mini targets pass before and after the change.
The reported production latency remains unreproduced.

Use `--baseline <original-function.sql> --migration supabase/migrations/20261130000100_player_page_speed.sql` for the paired recipe.
For release 2.6.3, obtain the Hashtag baseline with `git show 30a5b2a0:supabase/sql/functions/by-name/public/get_dynasty_forecast_inputs.sql`.
The recipe rolls back all definitions after the comparison.
The snapshot guard rejects a changed value, added field, or reordered array.
A deliberately changed real overview snapshot fails one test while the other 24 pass.

## Player read release order

Migration `20261130000100` replaces the dynasty reader without changing its inputs, output columns, grants, or JSON values.
Apply this migration through the normal database release process.
Database, then Edge, then merge the frontend.
This task only commits local changes.
It does not run a release.

## Verification

| Check | Result |
| --- | --- |
| `PLAYER_PAGE_EVIDENCE=<final.json> npx vitest run --maxWorkers=2` | 4,195 pass; zero fail; 39 existing gated tests skip. |
| Captured performance and snapshot tests | 25 pass, including 18 complete JSON comparisons and all latency targets. |
| Deliberately changed real snapshot | One expected failure; the other 24 tests pass. |
| `psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/dynasty-decision-inputs.sql` | Pass, including custom scoring, pagination, and authorization. |
| `npm run check:quality` | Pass, including lint and every configured type check. |
| `npm run generate:db-function-catalog` | Pass; generated catalog stays unchanged. |
| `npm run generate:database-types` | Pass; generated types stay unchanged. |
| `node scripts/regenerate-release-history-attestations.mjs` | Pass; both attestations include all 627 migrations. |
| `npm run check:db-function-catalog` | Pass against the private database. |
| `npm run check:database-types` | Pass against the private database. |
| `npm run check:db-function-sources` | Pass. |
| `node scripts/regenerate-release-history-attestations.mjs --check` | Pass. |
| `git diff --check` | Pass. |

The release-order test now reads these health notes and accepts the existing supplied-head wording.
Its negative checks still reject missing sections, migration numbers, and production-head declarations.
An earlier full run rejects an experimental migration with stale attestations.
The final full run uses the retained migration and passes.

The private stack stops after verification, and its database volume is removed.
Copied backup files and raw response snapshots are deleted.
Private timing results, plans, and matching snapshot hashes remain available.
Production, CI, deployment, email, and push services receive no request.
