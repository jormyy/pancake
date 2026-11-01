# Game-night replay lab

Run `node scripts/bench/game-night/run.mjs --help` for usage.
Run `node scripts/bench/game-night/run.mjs --quality --policy --pool 2 --evidence PATH` for one training replay.
Use `--phase all` only for the original calibration and baseline workflow.
Use `--phase baseline` to repeat baselines with existing calibration and control evidence.
Run `node --test scripts/bench/game-night/lab.test.mjs` for focused harness checks.

Evidence defaults to `/Users/michaelchen/Documents/pancake-half-gig/evidence/`.
The runner creates its own project, ports, containers, and synthetic rows.
It stops and deletes its stack after success or failure.
It reads no project environment file or production data.

The database uses the repository migrations and native pg_cron jobs.
A guarded Deno router loads the real Edge entry points.
It uses native clocks and timers. Each feed change occurs every 20 real seconds.
One full worker cycle warms caches. Measurement starts five seconds before an even UTC minute.
The timed training window lasts four minutes. Calibration and idle controls use its first two minutes.
Final feed values remain stable during the last 30 seconds.

The training slate spans 4 PM through 7 PM and reaches five simultaneous live games.
The held-out slate has twelve games and heavier overlap.
Slates use relative times so native worker clocks match each run.
No SQL clock replacement or product function rewrite occurs.

The fixture has ten fantasy teams, 2,600 players, and 246,000 historical stat rows.
It includes real lineups, matchups, forecasts, and derived player totals.
Synthetic historical activity fills the remaining allocation to about 265 MB.
Synthetic completion history keeps weekly ranking and projection imports from becoming unrelated startup catch-up work.
Live ingestion, score publication, forecasts, screen refreshes, and the installed cron schedules stay active.
Database allocation appears in every report. It is not a production backup.

The database cgroup receives the memory cap. Swap remains available.
Swap rates use the Linux VM's page counters. They include other VM activity.
The report states when calibration does not reach production's rate.
Anonymous memory uses five-second samples. The kernel peak includes all charged memory.

Each report includes raw counter boundaries, statement rows, worker receipts, feed requests, and correctness checks.
Statement groups sum duplicate query IDs across roles and nesting levels.
Nested times and WAL overlap. They do not sum to exclusive totals.
The seeding session closes before warmup. Observer SQL uses a fresh persistent session with statement tracking disabled.
Session counts include Docker health probes. The summary separates their expected rate from application costs.

The final-state control deletes one stored final stat before the normal check.
The no-ingestion control leaves cron active and disables live ingestion at the router.
Both controls must fail their stated gates before baseline results are accepted.

The quality replay drops a bench player, saves a lineup, offers and accepts a trade, and processes a due waiver claim.
It uses real authenticated routes and the real dispatcher. Trade and waiver notifications must exist when the action completes.
The due claim is synthetic historical input released during the window. The worker applies the normal eligibility and roster rules.
Baseline action limits use three successful runs and include their observed timing spread.
Pass `--limits action-limits.json` to enforce those frozen limits.
Pass `--phase controls --quality --policy --limits action-limits.json` to inject slow actions, dropped score broadcasts, and a missing forecast.
The score freshness limit is 45 seconds. An authenticated Realtime subscriber must receive score broadcasts.
Injury and forecast policy checks run during warmup, in rollback-only transactions.
Real forecast publication must also cover all five matchups within the approved thirty-minute interval.

Use `--source PATH` to replay another checkout with the same harness.
Use `--profile-memory` only for diagnosis; concurrent context probes touch pooled backends and change the workload.
Process memory samples record proportional resident and swap memory. Do not add shared mappings once per process.
`--pool`, `--pool-lifetime`, and `--pool-idle` replace only this stack's PostgREST container.
`--shared-buffers` restarts only its database before migrations. Every report records the applied settings.
Production settings require the separate procedures in `docs/half-gig-settings.md`.

`series.mjs` compares at least three baseline and candidate reports. It rejects different fixtures, caps, harnesses, or changing settings.
It rejects runs that overlap other Docker containers. It writes the summaries, action limits, and comparison outside the repository.
The held-out command requires a passing training comparison before it loads the held-out fixture.
Use `--phase held-out --training-result comparison.json` only after training reaches its target.

The cost model follows `docs/io-audit.md` and `docs/operations-scheduler.md`.
Fixture shapes follow `scripts/load` and `scripts/bench`.
Worker routing, network guards, and persistent observation follow `scripts/season-sim` and `scripts/perf-lab`.

The frozen contract sets the bar. Reports distinguish product changes from local runtime settings.
The principles used here freeze the bar, prove the gates can fail, and report measurement limits.
