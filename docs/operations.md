# Operations

This runbook explains Pancake's background work and how to diagnose it.
For pause and resume steps, use the [worker incident controls](../supabase/RELEASE-DB.md#worker-incident-controls).
Run every database check here against an isolated local stack, never production.

## Dispatcher and work queue

Cron calls `public.dispatch_work()` once a minute on one shared database connection.
The dispatcher checks the operator pause and an advisory lock before it starts work.
It admits at most 32 items per call and starts no new item after two seconds.
At most four unexpired work leases run at once.

| Work | Cadence |
| --- | --- |
| Live source tick | Every 30 seconds while games are live; none on idle slates |
| Database import in public mode | Status changes, finals, corrections, and 30-minute recovery checkpoints |
| Saved screen computation | At most every two minutes during games; user actions stay immediate |
| Matchup win odds | Every 30 minutes during games, once at matchup end |
| Standings | Weekly matchup end, initial fill, and setup changes |
| Season totals | Game end and final-stat corrections |
| Trade analysis | At creation, nightly, and one catch-up pass after matching pick predictions |
| Injuries | Every 15 minutes from two hours before first tipoff through last tipoff; hourly earlier that day; daily on off days |
| Projections | 08:00 PT and one hour before first tipoff |
| Stat corrections | Daily at or after 06:20 ET, for the previous seven dates |
| Rankings, trade values, pick predictions, player details | Nightly, 04:00 to 06:00 ET |
| Cron and operational history cleanup | Hourly at :12 |

Live games do not gate or defer nightly work.

### Leases and retries

Work leases last five minutes.
The live-ingestion lease lasts 90 seconds and renews every 60 seconds.
Lease loss stops writes.
Each lease request has at most five seconds and must finish one second before the known lease expiry.
Failed work retries with backoff from one minute up to fifteen minutes.
The third failed attempt makes the item dead.
Value-source failures keep their own policy of four retries at 30-minute intervals.

### Load shedding

`get_scheduler_health()` returns the last measurement, recovery start, manual pause, and admin hint.
Check `checked_at` first; a stale timestamp means you cannot trust the state.

| State | Entry rule | Admission |
| --- | --- | --- |
| `normal` | Initial state, or ten continuous healthy minutes | Full schedule and four-worker cap |
| `shed` | Success below 80%, average above three seconds, or no health data | Essential kinds only, with slower live polling and waivers |
| `paused` | Success below 50%, or any startup timeout | Live totals each dispatch; other critical work every five minutes |

Essential kinds are live polling, score and stat sync, waivers, trades, invocation reconciliation, and live matchup refresh.
Automatic `paused` differs from the operator pause, which stops all dispatch.
A failed check, a missing sample, or a gap above 90 seconds resets recovery.
The watchdog cannot recover cron when the dispatcher cannot start at all.

### Diagnose a queue stall

1. Read `SELECT * FROM public.work_dashboard();` for due, running, failed, and dead work.
2. Note the age of the oldest due item and any expired leases.
3. Read `SELECT * FROM public.get_scheduler_health();` and check `checked_at`.
4. Read recent `cron.job_run_details` outcomes and current locks in `pg_locks`.
5. Capture the full error context, wait samples, and resource metrics before you assign a cause.

A cron startup timeout does not name the slow inner statement.
An empty failed transaction does not prove that no work ran.
Run `tests/db/dispatch-short-work.sql` when you change dispatch admission.

### Lock waits during live scoring

Service-role requests use `lock_timeout=250ms` and `statement_timeout=3s`.
Live ingestion retries transient database failures up to four times per tick, counted in `tickRetries`.
Run the contention test when you change identity writes, injury writes, or the career trigger:

```sh
PANCAKE_LIVE_LOCK_DB_TESTS=1 deno test --no-lock --allow-env --allow-read --allow-net=127.0.0.1 --allow-run=psql,supabase supabase/functions/live-poll/contention.test.ts
```

## Retention

The `retention-prune` item runs daily after 10:00 UTC and calls `private.run_retention()`.
Each deletion statement has its own bounded batch and skips locked rows.
A failed table records a short error, and the other tables continue.
`SELECT * FROM public.retention_dashboard();` lists every table with its size, rule, and last prune.
Cleanup keeps active work, required failure evidence, and the newest outcome per function.
Operational cleanup never deletes `private.trade_offer_requests`, because trade history needs those receipts.
Official game statistics, results, and league history have no automatic expiry.
Delete Storage files through the Storage API, because SQL metadata deletes orphan the blobs.

`screen-statistics` runs `private.refresh_screen_statistics()` daily at 10:15 UTC on its own connection.
It skips fresh tables, and never-analyzed tables always require sampling.

To measure growth, capture `node scripts/db-health/index.mjs --output <file>` twice on the same server and fixture.
Then run `node scripts/db-health/index.mjs --compare <first> <second> <days>`.
An accelerated replay must supply its actual simulated interval to the comparison.

## Data sources

| Source | Supplies | Healthy when |
| --- | --- | --- |
| NBA CDN | Schedule, scoreboard, box scores, final stats, NBA IDs | Recent `sync_runs` success |
| ESPN public JSON | Names, teams, positions, injuries, news, birthdates | Daily player sync succeeds |
| Sleeper (RotoWire) | Primary per-game projections | Success within eight days; 300 players covered in season |
| FantasyPros | Backup projections | All three types attempted within 48 hours |
| Hashtag Basketball | Rankings | Each view meets its row floor |
| NBA draft order | Draft picks | At least 50 verified picks |

`PLAYER_SYNC_SOURCE` defaults to `espn`; `sleeper` turns on the Sleeper player fallback.
Offseason FantasyPros skips and Sleeper coverage gaps are expected.

### Recover a failed source

1. Read the latest failed `sync_runs` row and its error.
2. Compare worker and transport outcomes for `cron:` records.
3. Confirm the upstream shape with one read-only request.
4. Fix the parser, endpoint, or credentials in development.
5. Run `npm run check:source-recovery`, then `E2E_SOURCE_RECOVERY_VERIFIED=1 npm run e2e:source-health`.
6. Confirm a newer success with complete row counts.

### Final stats and corrections

Live polling rechecks today's and yesterday's completed games after thirty minutes.
The daily correction pass rereads NBA final boxes and writes through the normal stat writer.
Final snapshots keep the provider publication time, and the database skips older revisions.
Scores and stat lines commit together.
Final certification removes an absent inactive row only when it is an explicit DNP.
That row must have `did_not_play=true`, zero minutes, and explicit zeros for every numeric stat.
Both double-double flags must be false.
Check failed range jobs before you trust a completed schedule check.

### Projections

`private.projection_sync_due_work` sets the Sleeper and FantasyPros windows in `America/Los_Angeles` time.
Sleeper runs only on dates inside a scoring week.
Pancake seasons use the ending year, and Sleeper seasons use the starting year.
A pull that matches under 70% of stored upcoming games updates rows but deletes nothing.
It then records `source_metadata.coverageGuard` and fails the run.
A Sleeper row must match a regular-season scheduled matchup by date, team, and opponent.
Today and future rows must also match the player's current team.
FantasyPros is ineligible when league scoring needs makes or attempts that it lacks.

### Player identity

Name matches alone cannot join established NBA identities.
A different non-null source ID is never overwritten; ambiguous records stay as review items.
An ESPN or Sleeper ID must agree with its stored owner's normalized name.
An ambiguous import fails the sync and blocks roster cleanup.
A box player can join an ESPN identity when NBA ID matching fails.
That ESPN row must have no NBA ID and no later conflicting team listing.
Provider IDs, known birthdates, and known experience must agree before a merge.
Invalid and future birthdates never replace a saved birthdate.
Reviewed exceptions live in `supabase/functions/_shared/playerIdentityCorrections.md`.

An omitted player changes team only when a later stored box proves a different team.
That box must follow his latest ESPN placement or stored box for the old team.
A complete roster cycle needs ESPN and NBA to cover all 30 teams and at least 350 players each.
Every listed source ID must resolve before the cycle records membership.
Two complete cycles at least 24 hours apart can clear a player absent from both sources.
Run `supabase/sql/player-data-audit.sql` to see missing source fields and pending absence holds.
[League rules](roster-lifecycle.md#taxi-eligibility) owns taxi eligibility.

## Live scores

`GET /api/live/YYYY-MM-DD` in `api/live/[date].js` serves compact NBA game lines for today and yesterday, Eastern time.
NBA box scores come first, and ESPN is the checked fallback.
Visible live screens poll every 20 seconds and add live deltas to the saved score.
Late schedule rows use the current clock to decide whether polling must start.
A snapshot over two minutes old shows saved scores in a stale state.
Stale mode rereads saved views every 20 seconds; fresh public mode checks every ten minutes.

Postgres receives status changes, finals, corrections, and 30-minute recovery checkpoints.
Start receipts lock lineups when a game starts early, before stat imports run.
Each game imports on its own, and a failure never advances a successful checkpoint.
A missing or stale shared snapshot cannot block due direct-provider recovery.

### Roll back live scores

| Action | Phones | Workers |
| --- | --- | --- |
| Revert the feature and merge | Vercel redeploys the database-backed client | Deploy the matching Edge code too |
| Unset Supabase `LIVE_SNAPSHOT_BASE_URL` | Stay in public mode; stale data falls back to saved scores | New invocations use 30-second database ingestion |
| Set Vercel `LIVE_SCORES_OFF=1` and redeploy | Route returns `mode: database`; phones switch on next poll | Workers using the route switch too |

```sh
supabase secrets unset LIVE_SNAPSHOT_BASE_URL --project-ref <project-ref>
```

Phones do not read worker secrets, so unsetting the secret alone does not move phones.
Capture the current settings before release, and restore the public origin to re-enable checkpoints.
A code revert does not undo migrations or hosted settings.

### Hosted settings and plan limits

The tested configuration uses `shared_buffers=32MB` and a PostgREST pool of two.
Set `shared_buffers` with `supabase postgres-config update --project-ref <project-ref> --config shared_buffers=32MB --experimental`.
Read back `pg_settings.setting` and `pending_restart`, then restart.
Keep the prior values for rollback.
The owner sets the PostgREST pool in the hosted dashboard; the CLI cannot set it.
On the Supabase free plan, database size and monthly transfer are the tightest limits.
Official history has no expiry, so choose a data policy or a larger plan before the database nears 500 MB.

## Matchup forecasts

The header reads one shared forecast per matchup and never computes odds during the screen load.
Pregame points come from `get_league_projection_rows`, and the source must be fresh for the game date.
Completed games never add projection points again.
Input changes mark affected forecasts stale, and a three-minute lease prevents overlapping work.
A newer input revision rejects an older result, so stale work cannot publish.
Completion locks league and matchup rows before the forecast queue, the same order scoring uses.
Synthetic projections must remain labeled in any forecast evidence.

When a projection is missing, a live game uses its frozen value, then its daily projection, then the recent-game mean, then zero.
A pregame game uses the league's current-season average, then zero.
Substituted games appear in `missingInputs`, and the header marks those totals with `~`.

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/matchup-forecast-cache.sql
node supabase/tests/db/matchup-forecast-concurrency.mjs
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/matchup-forecast-season-average.sql
```
