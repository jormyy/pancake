# Game-night replay lab

Run `node scripts/bench/game-night/run.mjs --help` for usage.
Run `node scripts/bench/game-night/run.mjs --quality --policy --pool 2 --evidence PATH` for one training replay.
Use `--phase all` only for the original calibration and baseline workflow.
Use `--phase baseline` to repeat baselines with existing calibration and control evidence.
Run `node --test scripts/bench/game-night/*.test.mjs` for focused harness checks.
Use `cleanup.mjs --evidence PATH --project RECORDED_PROJECT` to stop an interrupted stack. The recorded identity must match.

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

## Public live-score architecture

Run `node scripts/bench/game-night/runtime-check.mjs` for a fixed-state integration check. It connects ten authenticated subscribers and proves that the server switch selects both worker paths. It does not collect a swap comparison.

Add `--public-live --quality --policy --pool 2` to a training replay for the new architecture. Add `--phones` when running the original checkout for its paired reference. The public route runs separately with only public-feed configuration. Its network permission allows only the local feed and listener. It receives no Supabase keys.

Phones run the shared overlay, polling, and recovery code. They read real authorized home views and subscribe to real Realtime broadcasts. Reports count only timed broadcasts and requests. The report includes phone freshness, final fixture agreement, public-cache work, payload size, response time, calculation time, and home-read cost.

Grader v6 requires due recovery checkpoints, final transitions, saved rows, worker starts, origin reads, and phone polls inside the window. Stored-score freshness remains a separate reported measure. Phone freshness supplies the live-screen quality gate. The feed holds its final window state while scheduled checkpoints settle outside measured counters. The unchanged final-state check then compares every fixture stat and score.

Phone recovery tests run before each phone replay with a controlled clock. They exercise the real route, cache, poller, and overlay. Full-stack phone controls use `phone-final` and `phone-stale`. The former alters one simulated display; the latter supplies an expired response to one phone. Neither changes product code. `--phase controls` also runs the original dropped-stat and ingestion-off controls.

Projected budgets extrapolate the peak window to ten phones, six hours nightly, thirty nights. They show local-route CPU assumptions, cache-region bounds, observed API-body transfer, Realtime delivery, database size, memory, and block IO. A value above half its allowance carries an explicit risk flag. The 250 disk operations per second limit is the documented Nano sustained baseline, not a monthly quota.


The Docker event watcher rejects any foreign container start during warmup or measurement, including starts between five-second samples. A 325-millisecond control demonstrates that detection. Existing foreign containers also invalidate a run.

The dropped-stat control first requires a valid unmodified final state and real timed work. The ingestion-off control must save no live rows while cron still runs. A definitive missed-final deadline can stop settling early; that run remains failed. Passing runs still wait for their scheduled thirty-minute checkpoint.

The local cache models Vercel's lack of server-side `stale-if-error` support. The route supplies a bounded in-memory last-good response without changing its source timestamp. Cold instances fall back to an uncached error and saved phone scores.

The dispatcher permits 32 completed or admitted work items within its two-second budget. The existing four-active-worker cap remains. Completed SQL jobs no longer postpone live ingestion by consuming the whole four-claim budget.

Use `verify-phone-history.mjs --evidence PATH` to verify official corrections on ten authenticated phones. Run `architecture-series.mjs` only after the settings comparison succeeds. Both measurement series keep the source, fixture, cap, and runtime configuration fixed.

## Failed reference runs

The original commit can fail the added reliability gates under action load. A failed reference never becomes a passing report. The paired series retains its final-state and job-failure evidence and labels its summary as a resource reference. It requires real timed work and no OOM or foreign Docker activity. All baseline actions must still complete before their observed times define candidate limits.

Candidates must pass every run gate. The final resource bar is the smaller of 106 pages/s and five percent of the paired reference median. A reference that processes fewer updates can understate the original cost; its rates do not establish equivalent completed work. The historical complete-work baseline remains separate. Comparison reports expose `baselineQualityPassed` and every failed reference run.

The phone grader requires a successful broadcast-triggered saved-screen refresh for every phone inside the measured window. Message receipt alone is insufficient. The replay decodes the same batched hint and public row-change envelopes as the app and advances its version cursor. The `phone-refresh` negative control still receives broadcasts but skips phone 1's saved-screen refresh.
