# Game-night replay lab

Run `node scripts/bench/game-night/run.mjs --help` for usage.
Run `node scripts/bench/game-night/run.mjs` for calibration, controls, three baselines, and the held-out run.
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
Observer SQL uses one persistent session with statement tracking disabled.
Session counts include Docker health probes. The summary separates their expected rate from application costs.

The final-state control deletes one stored final stat before the normal check.
The no-ingestion control leaves cron active and disables live ingestion at the router.
Both controls must fail their stated gates before baseline results are accepted.

The cost model follows `docs/io-audit.md` and `docs/operations-scheduler.md`.
Fixture shapes follow `scripts/load` and `scripts/bench`.
Worker routing, network guards, and persistent observation follow `scripts/season-sim` and `scripts/perf-lab`.

The frozen contract sets the bar. The lab measures a baseline and makes no product optimization.
The principles used here freeze the bar, prove the gates can fail, and report measurement limits.
