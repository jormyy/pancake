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

On Colima, the functions runtime needs temporary files on a shared mount.
If startup reports `failed to determine entrypoint`, set `TMPDIR` to a task directory under the shared home before serving functions.

The release-provenance check in the browser harness requires the copy to have a git `HEAD` equal to the expected SHA.

## Correctness

Supported clients are iPhone Safari PWA and desktop browsers. No native app or simulator is required.
Run `npm run e2e:web-targets` after the local release server and seed are ready.
Use `-- --actions` for form and admin actions. Use `-- --gameplay` for league, lineup, waiver, draft, and trade settlements.
The matrix covers WebKit phone layouts, simulated standalone mode, and desktop Chromium and WebKit.
See [the exact matrix and commands](../tests/e2e/README.md#supported-web-clients).
Use its pinned Chromium path for legacy browser checks too. This keeps their engine consistent with the matrix.
Set `E2E_PWA_PREVIOUS_ROOT` and `E2E_PWA_NEXT_ROOT` to check updates between two complete stamped builds.
Without these inputs, the report explicitly marks the two-build check `NOT_RUN`.
Physical installation, the iOS keyboard, and background suspension still require a real iPhone.

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

## Pre-tipoff lineup benchmark

`scripts/bench/README.md` describes the deterministic season driver and isolated database setup.
The driver runs the base Edge code and the candidate against the same pinned NBA schedule and fixed seed.
It measures real PostgreSQL statement and tuple counters, including each production cron predicate tick.
It checks every opted-in team at every distinct tipoff with an independent assignment oracle.
Keep measured results and logs outside the checkout. Report local measurements separately from hosted costs.

## Dynasty rules, skipped weeks, and trade plans

Run `npm run test:db:dynasty-rules`, `npm run test:db:trade-roster-plans`, and `npm run test:db:trade-plan-concurrency` against an isolated local stack.
The first recipe checks the Pacific Oct 20–25 boundary and the report-only target calendar.
It generates regular weeks 2–17 and two two-week playoff rounds spanning weeks 18–21.
The trade recipes cover stored plans, settlement rollback, capacity, IR/taxi transfers, and concurrent drop reservations.
All three recipes are part of `npm run test:db`.

New leagues created through `create_league` start playoffs at week 17.
Existing leagues keep their saved start and legacy duration rules.
Commissioners can set any team limit of at least two. Entrants range from two through the actual league membership.
The number of elimination rounds is ceil(log2(entrants)). No product cap limits entrants or rounds.
Each round accepts its own positive week length. Top seeds receive the required first-round byes.
Calendar gaps, too many entrants, and mismatched round counts produce explicit errors.
A changed playoff plan can rebuild an unstarted schedule under the existing schedule lock.
Team count follows the existing setup lock. Existing capacity and scoring locks stay in force.
Taxi eligibility and tenure are prospective policies. Commissioners can change them for acquisition checks and season rollover.

Skipped weeks belong to one league season. The date selector displays date keys in Pacific time.
Before generation, skipped weeks create no matchups and do not consume the round-robin rotation.
Voiding an existing week retains marked matchup history, clears its decision, and rebuilds later regular standings.
Scoring, seeding, and automatic season transitions ignore voided matchups.
Standings-derived draft and waiver orders use the rebuilt snapshots.
Saved skips cannot be restored through this control. Playoff seed creation locks further week voids.
The commissioner selects these settings; migrations change no saved league or matchup data.

Configured brackets store explicit round numbers and branch positions. Seed order follows the standard balanced elimination tree.
Only the first round has byes. Every later round pairs neighboring winning branches.
Earlier rounds reuse the legacy quarterfinal phase value for compatibility; their explicit round numbers control advancement and scoring locks.
Legacy null settings retain the original bracket and duration rules.
Run `npm run test:db:general-brackets` for large brackets, every advancement, exact windows, odd leagues, and invalid plans.

## History and operational retention

`npm run test:db:retention` runs the real cleanup function inside a rollback transaction.
Statement triggers reject any cleanup write to public tables except `sync_runs` and `edge_invocations`.
They also reject changes to score-retirement markers.
The fixture retains every season's lineups, standings, transactions, and projection source rows.

Cleanup removes completed successful high-frequency operational records after seven days.
It keeps failures, unfinished work, unknown jobs, and important daily or weekly outcomes.
Removed cron jobs qualify only when their command matches a known operational worker or optimizer gate.
The test covers the exact seven-day boundary and calls cleanup as anonymous, manager, and service roles.

`npm run test:db:retention-scoring` checks that cleanup preserves historical scores and their replay inputs.
It separately creates a new local fixture with missing legacy inputs to retain coverage of existing retirement guards.
That fixture does not describe the current cleanup policy.
Migration `20261018000001` replaces function bodies only and invokes no cleanup during deployment.


## Draft job failures and Eastern season starts

`npm run test:db:expired-draft-outcomes` uses local HTTP, real RPCs, and row-specific fault triggers.
One auction closes while an auction and a snake pick fail.
The endpoint returns `ok: false`, HTTP 500, and a finished failed `sync_runs` row.
After trigger removal, two concurrent calls settle each remaining action once.
A final retry does no work.
A request without internal authentication cannot run the job.
The recipe removes only its fixtures and triggers.

`npm run test:db:season-boundary-et` calls the real boundary helper against local data.
It checks the evening before Eastern midnight and the first minute after midnight.
The cases cover the spring clock change, the fall clock change, and New Year.
The evening call creates no draft.
The later call creates and completes the synthetic rookie draft.
Both recipes run in `npm run test:db`.

## Correlated scheduled work

`npm run test:db:correlated-dispatch` checks canonical outcomes, bounded retries, stale claims, and actual client-role denials.
`npm run test:db:correlated-worker` sends real local HTTP requests through the internal handler.
It also queues a real pg_net request whose worker finishes after the 30-second transport timeout.
Set `E2E_INVOCATION_WORKER_HOST=host.lima.internal` for a Lima stack.
The default is `host.docker.internal`; the container must reach the test listener on the host.
The worker test uses an ephemeral local port and removes only its own operational fixtures.

Each scheduled request carries an opaque invocation key after internal authentication.
The worker records one outcome, including completed rows when individual items fail.
Transport errors remain diagnostic evidence; a completed worker determines success or failure.
Reconciliation waits ten minutes for a worker, then marks its existing outcome failed if it never finishes.
A late finish corrects that same outcome.

Daily ET jobs check every fifteen minutes after their normal due time.
A failed claim can retry after five minutes, with at most three attempts per period.
Ranking checks run hourly and keep the existing weekly claim.
Reconciliation waits for every request in a claim before releasing it.
An older failed attempt cannot release a newer claim.
No retry changes league history or settings.

## Bounded live ingestion

`npm run test:db:live-ingestion-work` checks shared eligibility, retry boundaries, client-role denials, and stale-holder write fences.
`npm run test:db:live-ingestion-clock` uses real HTTP, the local database, and real timers.
It observes six ticks about twenty seconds apart, duplicate exclusion, a killed process, the natural ninety-second lease expiry, finalization, and provider backoff.
The clock recipe takes several minutes and removes only its synthetic league, games, players and users.
The default runs host Deno; `LIVE_POLL_USE_EDGE=1` targets the local Edge endpoint with an explicitly configured local provider.
The latter mode needs `LIVE_POLL_PROVIDER_URL` and the matching `NBA_CDN_BASE_URL` in the local functions environment.

The cron checks every two minutes, at every UTC hour.
Live games and the two minutes before a scheduled tipoff start a bounded loop.
Healthy loops start up to six ticks at twenty-second intervals.
Each tick has an eighteen-second network budget; the invocation also has a hard work deadline.
Every database write carries its lease identity and fails if that identity expires or changes.
The database holds the lease lock through each write transaction, so a replacement waits for an admitted write to finish.
A lost lease aborts outstanding network work.
Bookkeeping has a separate five-second budget and can record failure after the work deadline.

The scheduler and worker use the same final-completion marker and thirty-minute retry rule.
One partial stat row cannot certify a final game.
Retry timestamps stay in a private operational table.
They do not emit client events or change game content, completion stamps, or score-input revisions.
A completed final game does not wake an idle worker.
During live activity, due completed games still receive correction checks.
The broader historical recovery in normal score sync stays enabled; the live loop scores its already-ingested inputs once per tick.
