# Live scores

## Data contract

The public route `GET /api/live/YYYY-MM-DD` returns compact NBA game lines.
It accepts today and yesterday in Eastern time.
It reads no Supabase data, credentials, lineups, or user information.
NBA box scores are preferred; ESPN remains the checked fallback.
Identity, completeness, and source-order checks apply before publication.
Malformed rows are skipped independently; unavailable games do not create empty substitute rows.
Each player line contains only the fields needed by the shared scoring formula.
Explicit DNP rows contain zero statistics; absent provider rows remain missing.
Duplicate date parameters fail. Other accepted URL forms redirect to the canonical path.
Each warm origin limits provider refreshes to once per date every 20 seconds, including failed attempts.
A game whose scoreboard score, clock and status are unchanged reuses its last box, live for up to 60 seconds and finished for up to 5 minutes.
Phones keep the last good feed through a failed check until it is two minutes old.

Vercel serves the function beside the static Expo export.
The API rewrite precedes the static-page fallback in `vercel.json`.
Responses use `s-maxage=20`, `stale-while-revalidate=10`, and `stale-if-error=90`.
Vercel does not implement the last directive for its server cache.
The origin therefore retains at most two dates of last-good data, with the original capture time.
An origin without usable cached data returns an uncached error.
Responses over 1 MB are rejected, below the 4.5 MB function and 10 MB cache limits.
See [Vercel cache rules](https://vercel.com/docs/caching/cache-control-headers) and [limits](https://vercel.com/docs/limits).

Visible live screens poll every 20 seconds while a game is live.
Hidden screens stop polling.
The client adds shared-formula live deltas to its authorized saved score and lineup basis.
The same calculation serves Home and other-team matchups.
The shared scorer uses exact decimal products and the same cent rounding as SQL.
Completed official games use saved results, without a public delta.
A future scheduled player keeps the saved contribution while live teammates continue updating.
The existing saved game time distinguishes a future game from missing live data.
Unfinished games in the selected matchup period keep polling across league midnight.
Each active game date uses the same public cache and stops after official handoff.
Contributions remain tied to their lineup date when a player appears on consecutive days.
Cancelled, postponed, and suspended games do not supply live deltas.
A stale displayed matchup triggers short recovery even when the selected matchup is fresh.
Late-arriving schedule rows use the current clock when deciding whether polling must start.
Past days remain available from saved views; the public route is not a history service.
A snapshot over two minutes old, or unavailable, shows saved scores with a stale state.
Opening a live screen and reconnecting start a fresh read.
Each phone retains the last accepted game timestamp and final state across reconnects.
Older provider revisions cannot reverse a displayed final. Newer final corrections remain eligible.
A requested date selects its own week within a multi-week matchup.
Score corrections refresh every week in that matchup; lineup changes remain scoped to the selected week and date.

Postgres receives status transitions, final statistics, corrections, and recovery checkpoints every 30 minutes.
Public workers discover starts across the full snapshot, including games outside their selected work.
A start receipt locks the lineup before the stored scheduled time when a game starts early.
Start receipts run before selected stat imports and recovery, with a separate bounded budget.
Per-game receipt deadlines isolate slow writes and preserve time for imports.
Start publication bypasses silent-checkpoint suppression.
Each game imports independently. Only successful imports advance that game's checkpoint.
Official writes use the existing per-game provider ingestion and NBA final certification.
Versioned final scores and stats commit together; unversioned feeds retain the existing score-then-stats path.
The base path can accept an incomplete NBA final that omits a player; this remains a known follow-up.
No new participation table or final-total validator blocks legitimate finals.
Each attempt is recorded under the existing lease before provider calls.
Slow failed recoveries rotate behind untouched games on the next tick.
Their failure order survives worker restarts; a failure never advances a successful checkpoint.
A missing, stale, or contradictory shared snapshot cannot block due direct-provider recovery.
ESPN completion triggers repeated authoritative checks; only the existing NBA rules certify official finals.
Final-score corrections remain eligible for forecast refresh within the existing seven-day queue retention.
Other out-of-window requests are removed, so they cannot block current forecasts.
Workers decode compact forecast inputs without changing the calculation.
Claimed results publish in one transaction; one bad result does not roll back healthy results.
Cache-only renewals do not broadcast. Changed forecasts identify the affected matchup.
A forecast-only change reads just that forecast and preserves saved scores and lineups.
Pure score and game changes fetch their scores, stats, and game state without unchanged lineups or forecast values.
A missed version, mixed change, or mismatched response requires a full authorized screen read.
Home reads use the league broadcast counter. Old Home content remains available offline; its obsolete counter resets before the next online read.
Nightly jobs run during 04:00–06:00 Eastern even when a game remains live.
There is no live-game claim gate or deferral.
All-Star projection windows use the full scoring-week date range.
Trade analysis waits for pick predictions that match the published value source.
Their completion can trigger one extra trade-analysis pass per day, including successful retries.
A normal live-only checkpoint saves data without a screen version or broadcast.
Stale-mode recovery rereads saved views every 20 seconds; finals and corrections retain their versions.
Tipoffs, finals, corrections, roster changes, and lineup changes retain their relevant broadcasts.
Home ignores changes outside its displayed teams, dates, and score inputs.
Fresh public mode checks saved views every ten minutes; unchanged versions need no screen read.
Stale or database mode uses the existing 20-second recovery check.
Official rules, final scores, locks, waivers, trades, and authorization remain server-owned.

## Rollback

The two settings affect different processes.
Phones do not read Supabase worker secrets.

| Action | Phones | Workers |
| --- | --- | --- |
| Revert the feature merge and merge that revert | The automatic Vercel deployment restores the previous database-backed client after its normal update flow | Deploy the matching previous Edge code, or unset the secret below, to restore ordinary ingestion |
| Unset Supabase `LIVE_SNAPSHOT_BASE_URL` | Remain in public mode; stale public data falls back to saved scores, not database mode | New invocations use ordinary 30-second database ingestion |
| Set Vercel `LIVE_SCORES_OFF=1` and deploy that configuration | The route returns `mode: database`; phones switch on their next successful poll | Workers using that route also use ordinary database ingestion |

There is no access to the Vercel account for this change.
The Vercel variable is therefore not an available operational rollback here.
Without a Vercel configuration change or a client deployment, phones cannot switch to database mode.
Unsetting the worker secret alone does not make phones follow the workers.
An already running worker keeps its chosen source until that invocation ends.
Allow cache expiry and the normal client update flow when checking rollback.

Use the separately authorized Supabase project for the worker rollback:

```sh
supabase secrets unset LIVE_SNAPSHOT_BASE_URL --project-ref <project-ref>
```

Capture the previous configuration before release.
Restore the saved public origin to enable checkpoints again.
A code revert does not undo database migrations or hosted memory settings.
Keep compatible functions and schema until both clients and workers finish their rollback.
League and membership events retain their legacy envelope during rollout.
Other data events use compact batches; loaded clients still receive their supported version hints.
Old loaded clients still receive league-setting changes before the new frontend deploys.
After workers enter public mode, old clients retain action and final events but show checkpointed intermediate scores.
They need the new frontend for live overlays; keep database-mode workers during the client update window if needed.
Worker rollback does not require a schema rollback or change this event compatibility.
See [release order](../supabase/RELEASE-DB.md#release-order-for-this-release).

The ordinary ingestion functions remain for database mode, checkpoint imports, finals, and corrections.
Player resolution, ambiguity checks, source watermarks, score revisions, and final certification remain required.
The legacy full work reader remains for database mode; public mode requests selected game inputs.

## Hosted settings

The measured configuration uses a 192 MiB local database cap, 32 MB `shared_buffers`, and a PostgREST pool of two.
The cap is a lab condition, not a hosted setting.
Local Supabase configuration does not set hosted services.

| Control | Hosted procedure | Verification |
| --- | --- | --- |
| `shared_buffers=32MB` | `supabase postgres-config update --project-ref <project-ref> --config shared_buffers=32MB --experimental` | Read `pg_settings.setting`, units, and `pending_restart`; restart is required |
| PostgREST pool 2 | Michael sets the Data API pool in the hosted dashboard | Record its configured value; this is separate from Supavisor |

The [Postgres guide](https://supabase.com/docs/guides/database/custom-postgres-config) requires organization Owner or Administrator access.
The [PostgREST endpoint](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config) requires `rest:write` or `data_api_config_write`.
Neither document lists a Free-plan exclusion for these controls.
Actual hosted acceptance and read-back remain unverified.
The installed CLI cannot configure that service pool. PostgREST does not support `db-pool` through SQL settings.
Preserve prior values for rollback. The CLI merges overrides unless replacement is requested.
No hosted setting changes occur during local measurement.

The connection trace finds three short Auth database sessions per authorized Home read.
The PostgREST data pool persists during those reads.
Fewer necessary screen reads remove Auth churn without caching authorization or shortening connection lifetime.
Pool three has no demonstrated benefit for this cause.

## Lab results

These are synthetic local results, not production capacity or billing proof.
The final runtime sample uses `826d2e3be71d433319c519f3a82e977061d0a3b9`.
It measures **20.036 anonymous refaults/s**, below the 35.09/s ceiling, with every quality and budget gate passing.
This is one unpaired final-code sample, as required by the final release check.
It is 98.96% below the recorded 1,930.923/s reference median.
The earlier 35.797/s sample and interrupted 6.5/s observation used earlier code and remain historical evidence.
The held-out result of 13.976/s also belongs to the earlier revision; it is not rerun for this release check.

The resource grader remains `game-night-cgroup-v1`, with `game-night-v9` quality checks.
The fixture, 192 MiB cap, 32 MB shared buffers, pool two, 30-second tick and 30-minute checkpoint are unchanged.
The primary counter is database-cgroup `workingset_refault_anon` per second; VM swap remains diagnostic.
The fixed 1 GiB VM available-memory floor and foreign-container diagnostics remain in the JSON report.
The final-state check includes scores and stats, official handoff, actions, forecasts, injuries, Realtime, work counts and failures.
The dropped-final control fails as intended.
Phone freshness p95 is 28.715 seconds, below 45 seconds.

| Per four-minute window unless stated | Recorded reference median | Final sample |
| --- | ---: | ---: |
| Provider calls | 79 | 75 |
| Provider response bytes | 1,589,531 | 1,372,138 |
| Database API calls | 1,425 | 186 |
| Database API decoded bytes | 5,862,558 | 556,345 |
| Full Home reads | 160 | 4 |
| Score-only reads | 0 | 10 |
| Phone wire bytes | 948,485 | 49,034 |
| Edge invocations | 283 | 25 |
| Broadcast sends / deliveries | 145 / 1,432 | 17 / 152 |
| New sessions/minute | 211.87 | 18.99 |
| Sessions/minute after probes and cron | 203.87 | 11.99 |
| WAL bytes/minute | 1,149,183 | 336,047 |

The reference uses the same ten-phone workload. Earlier database-only session counts are not directly comparable.
The public snapshot is 8,785 decoded bytes and 2,107 gzip bytes at its sample median.
The original deployed feed probe remains separate evidence: NBA boxes 31 KB, ESPN summaries 448 KB.

## Free-plan budget

The stress case is ten phones, six hours per night, thirty nights.
These current-sample projections are not hosted billing measurements.

| Resource | Projected use or measured peak | Allowance/reference | Share |
| --- | ---: | ---: | ---: |
| Database size | 265.637 MB | 500.000 MB | 53.13% |
| Database memory | 200.069 MB | 500.000 MB | 40.01% |
| Database disk operations | 80.682 /s | 250.000 /s | 32.27% |
| Supabase transfer | 2.230 GB/month | 5.000 GB/month | 44.59% |
| Edge invocations | 78,563 /month | 500,000 /month | 15.71% |
| Realtime messages | 456,053 /month | 2,000,000 /month | 22.80% |
| Realtime connections | 10  | 200  | 5.00% |
| Vercel requests | 261,758 /month | 1,000,000 /month | 26.18% |
| Vercel invocations, eleven regions | 237,471 /month | 1,000,000 /month | 23.75% |
| Vercel transfer | 0.552 GB/month | 100.000 GB/month | 0.55% |
| Vercel origin transfer | 2.086 GB/month | 10.000 GB/month | 20.86% |
| Vercel active CPU | 0.351 hours/month | 4.000 hours/month | 8.78% |
| Vercel memory | 0.858 GB-hours/month | 360.000 GB-hours/month | 0.24% |

Supabase transfer reaches 44.59% of 5 GB, below the 50% target.
Database size reaches 53.13% of 500 MB; the fixture remains unchanged.
Database size remains the named exception to the 50% margin target. The 55% transfer exception is not needed for this sample.
The Vercel invocation model retains eleven cache regions. One region projects 21,588 invocations; two project 43,177. Actual users usually use one or two.

Transfer uses measured encoded phone responses plus conservative decoded internal traffic, 300 cold opens and the unchanged 16 KiB recovery reserve.
The [official egress guidance](https://supabase.com/kb/troubleshooting/all-about-supabase-egress-a_Sg_e) describes outgoing bytes and both transfer legs.
It does not promise API-specific gzip billing. Local compression and byte lengths are verified; hosted compression and actual billing remain rollout checks.
Headers and TLS overhead are not modeled. [Realtime billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) counts sends and deliveries.
Official history has no automatic expiry; see [capacity and retention](operations-scheduler.md#capacity).


## Follow-ups

Three pre-existing cases remain outside this release gate.
The predecessor can accept an incomplete NBA final that omits a player.
Forecast inputs can omit an unfinished prior-day game after Eastern midnight.
An unexpectedly early first game remains undiscovered while no live worker is running.
Public start receipts fix active-worker discovery; they do not start a worker before its admission window.

## Inactive players and final certification

`public.save_game_stats_atomic(uuid,text,jsonb,boolean)` removes absent inactive rows before its final coverage check.
The row must have `did_not_play=true`, zero minutes, and explicit zeros for every numeric stat.
Both double-double flags must be false.
Null values, played rows, and nonzero values still fail the coverage check.
Live imports skip players whose box-score status is `INACTIVE`.
Final imports keep every supplied player.

Cleanup, stat writes, final certification, and the cleanup receipt share one database transaction.
A failure rolls back all four.
The integer result still counts inserted and updated rows.
Each cleanup writes a successful `sync_runs` receipt named `sync-stats:inactive-cleanup`.
Its `details` contain `game_id`, `nba_game_id`, and the complete `removed_inactive_rows`.
An unchanged revision creates no duplicate receipt.

## Stats certification release order

Apply `20261210000200` before updating Edge.
The migration adds the cleanup receipt field and replaces `public.save_game_stats_atomic`.
It preserves the existing RPC arguments and return value.
