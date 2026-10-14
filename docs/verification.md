# Verification and benchmark recipes

How to reproduce the checks behind recent changes on an isolated local stack. Everything here is local: it proves
behavior against controlled fixtures, not production traffic, devices, or natural daily schedules.

## Isolated local stack

Run from a copy of the repository so the stack gets its own project id and ports, never the default local `pancake`
stack:

1. Copy tracked files only (never `.env` files): `git archive <sha> | tar -x -C <copy>`, then `npm ci` in the copy.
2. In the copy's `supabase/config.toml`, set a unique `project_id` and shift every port (for example `543xx -> 553xx`).
3. `supabase start` (Supabase CLI 2.114). Export the stack's own values from `supabase status -o env`:
   `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_API_URL=$API_URL/functions/v1/api`,
   `E2E_SUPABASE_URL`, `E2E_SUPABASE_PUBLISHABLE_KEY`, `E2E_PANCAKE_SUPABASE_SECRET_KEY`, `SUPABASE_DB_URL`,
   `E2E_API_BASE_URL`, `E2E_FRONTEND_URL`, `E2E_ADMIN_SECRET`.
4. `supabase functions serve --env-file <file>` with `E2E_ADMIN_SECRET` and, for database recipes,
   `PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token` (the CI test value).
5. `PANCAKE_RELEASE_SHA=<full sha> EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH=1 npm run build:web:release`, then
   `node tests/e2e/static-web-server.mjs --root=dist --port=<port>`.
6. `npm run e2e:seed` (10 users, one league, 80 players). The seed deletes the previous seed's league and users; a
   fixture that makes a seed user own another league blocks that cleanup.

The release-provenance check in the browser harness requires the copy to have a git `HEAD` equal to the expected SHA.

## Correctness

| Check | Command | Notes |
| --- | --- | --- |
| Unit and contract tests | `npx vitest run` | Needs local sockets for `tests/soak-shards.test.ts`. |
| Quality gate | `npm run check:quality` | Lint, typechecks, `knip`, generated-code and inventory checks. |
| Browser scenarios | `node tests/e2e/browser-ci-scenario.mjs --scenario=<id>` | Ids from `tests/e2e/browser-scenario-manifest.mjs`; seed before scenarios that require it. |
| API dynasty gate | `npm run e2e:dynasty-release-final-gate` | 15 checks: adds, waivers, FAAB, trades, multi-team, preferences, feed, DB security. |
| Database recipes | `SUPABASE_URL=$API_URL PANCAKE_SUPABASE_SECRET_KEY=$SECRET_KEY PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token npm run test:db` | Same environment as CI's database job. |
| Multi-season soak | `E2E_ENABLE_BACKEND_TICKS=1 E2E_REPEAT_SCENARIOS_EVERY_SEASON=1 E2E_ENABLE_PICK_CHAIN=1 E2E_ENABLE_PUSH=1 E2E_ENABLE_HISTORY=1 E2E_ENABLE_REALTIME=1 E2E_ENABLE_<SLICE>=1 node tests/e2e/soak.mjs --seasons=10 --fake-port=<port>` | Enable every backend slice listed in `tests/e2e/backend-scenario-manifest.mjs`; without them most slices are skipped. Point Edge `NBA_CDN_BASE_URL`, `SLEEPER_BASE_URL` and `EXPO_PUSH_URL` at the fake port. |

## Benchmarks

| Measurement | Harness | Workload |
| --- | --- | --- |
| Main screens | `node tests/e2e/browser-ci-scenario.mjs --scenario=smoke` (`workflowMeasurements` in the report) | Reseed before each round; alternate builds; five rounds. |
| API and query latency | `npm run e2e:data-latency` | Run from the copy whose `supabase/config.toml` points at the isolated stack (the schema check uses `supabase db query --local`). |
| Realtime bursts and startup relaunch | Probes kept with the evidence, outside the repository | Real browser, 390x844, 150 ms RTT / 1600 kbps for startup. |

Keep generated reports and raw captures outside the repository. Interleave baseline and candidate runs, keep the
machine otherwise idle during timed runs, and report medians with ranges.

## Latest local results — 2026-10-13

Environment: one MacBook (Docker Desktop, 8 CPUs), Supabase CLI 2.114, Node 26, headless Chromium (agent-browser) at
390x844 unless noted, isolated stacks seeded by `npm run e2e:seed`. Baseline is `8a71bc62`. These are local results,
not production measurements.

| Area | Before | After | How measured |
| --- | --- | --- | --- |
| Reopen with an expired access token | 0/6 reached the saved league; sign-in, "No league" and wrong-league flashes | 6/6 at ~250 ms, no flashes | Relaunch probe, 150 ms RTT / 1600 kbps, interleaved n=6 |
| Reopen with a valid token | ~33 ms | ~35 ms | Same probe (control) |
| 20 membership changes on Home | 41 membership reads, 55 API requests; change visible after ~0.6-0.8 s | 2 reads, 16 requests; visible ~0.1 s later (the 250 ms batching window) | Real browser and local Realtime, interleaved n=5, two runs |
| 20 trade changes on Home | 20 badge RPCs | 1 | Same, n=5 |
| Main screens (8 routes) | cold load 342-426 ms | unchanged within noise, same request counts | Smoke sweep, 5 interleaved rounds with reseed |
| Player sync with one identity conflict | whole chunk rolled back; valid players not updated | valid players updated; the conflict still fails the run | Real endpoint, fake Sleeper feed |
| Natural scheduler, 130 min with a 12-minute Edge outage | — | 44/44 trades reached the right final state; recovery on the first tick after restart; FAAB conserved | `pg_cron` -> `pg_net` -> Edge on the wall clock |
| Simulated seasons, all backend slices | soak stopped in season 1 (stale harness) | 20 seasons pass; runtime drift 1.0% at seasons 8-10, 9.4% at 18-20 (limit 20%) | `tests/e2e/soak.mjs --seasons=20` with `E2E_KEEP_GOING=1` |

Synthetic hook harnesses (`tests/hooks/*-coalescing.test.ts`, `tests/hooks/live-data-unchanged-references.test.ts`)
cover the burst, held-read, hidden-page, account-switch and failure cases behind these numbers.

Known limits:

- No physical iPhone, Safari, or installed-PWA measurement. A headless WebKit engine check showed the same slots and
  saved-league restore; it is not device evidence.
- Realtime coalescing adds up to ~250 ms before another user's change appears.
- The soak's runtime-drift gate measures wall-clock time on one machine. One 20-season run failed it at 25% when every
  phase slowed together for two seasons and then recovered; rerun before treating a drift failure as a regression.
- Deleting historical `player_game_stats` clears completion stamps, so the next scoring run refetches and re-scores those
  past weeks. That is the intended recovery; test fixtures must not delete stats outside their own games.
- Natural daily and weekly schedules (waivers at 03:00 ET, season boundary) were not observed beyond the 130-minute window.
