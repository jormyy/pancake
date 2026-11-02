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
Each warm origin limits provider refreshes to once per date every 30 seconds, including failed attempts.

Vercel serves the function beside the static Expo export.
The API rewrite precedes the static-page fallback in `vercel.json`.
Responses use `s-maxage=30`, `stale-while-revalidate=15`, and `stale-if-error=90`.
Vercel does not implement the last directive for its server cache.
The origin therefore retains at most two dates of last-good data, with the original capture time.
An origin without usable cached data returns an uncached error.
Responses over 1 MB are rejected, below the 4.5 MB function and 10 MB cache limits.
See [Vercel cache rules](https://vercel.com/docs/caching/cache-control-headers) and [limits](https://vercel.com/docs/limits).

Visible live screens poll every 30 seconds while a game is live.
Hidden screens stop polling.
The client adds shared-formula live deltas to its authorized saved score and lineup basis.
The same calculation serves Home and other-team matchups.
The shared scorer uses exact decimal products and the same cent rounding as SQL.
Completed official games use saved results, without a public delta.
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

These are local synthetic results, not production capacity or billing proof.
The measured runtime is `9e620800836dfad7fa528c0dfa295b3b80ec73cd`.
Three candidates reuse the recorded reference; this comparison is unpaired.
The resource grader stays `game-night-cgroup-v1`; public quality uses `game-night-v9`.
Every run uses the same fixture, 192 MiB cap, 32 MB shared buffers, and PostgREST pool two.
Quality v9 checks each team against known past fixture states, because an official final can arrive before the opposing live update.
The earlier simultaneous-state check remains a diagnostic; final handoff and freshness gates stay unchanged.
The primary measure is the database cgroup's `workingset_refault_anon` delta per second.
VM swap counters remain diagnostics; the kernel exposes no normal per-cgroup swap-out rate.
A sample fails below 1 GiB VM available memory; foreign containers are recorded and left unchanged.

| Sample | n | Median anonymous refaults/s | Range |
| --- | ---: | ---: | --- |
| Recorded reference | 3 | 1,930.923 | 1,866.310–2,216.158 |
| Current training | 3 | 14.817 | 1.799–27.193 |
| Held-out reference | 3 | 3,167.493 | 3,114.448–3,432.218 |
| Final held-out confirmation | 1 | 13.976 | Single sample |

Training is 99.23% below the recorded reference, with a 25.394/s spread.
It passes the retained 35.09/s ceiling; held-out passes 158.37/s.
The held-out run confirms the corrected design after earlier use; it is not a new tuning set.
All four candidates pass their action, final-state, freshness, schedule, broadcast, and failure gates.
Training phone freshness p95 has a 26.790-second median and a 30.233-second maximum.
Held-out phone freshness p95 is 27.317 seconds, below the 45-second limit.
The dropped-final control fails as required.

The table uses ten phones on both sides and shows medians per four-minute window.
The reference includes the old full-screen refresh path; earlier database-only session baselines use a different workload.

| Measure | Recorded reference | Current candidate |
| --- | ---: | ---: |
| Provider calls | 79 | 75 |
| Provider response bytes | 1,589,531 | 1,372,138 |
| Database API calls | 1,425 | 193 |
| Database API decoded bytes | 5,862,558 | 530,449 |
| Full Home reads | 160 | 4 |
| Score-only reads | 0 | 10 |
| Mean Home gzip bytes | 6,008 | 4,887 |
| Phone wire bytes | 948,485 | 48,093 |
| Edge invocations | 283 | 25 |
| Broadcast sends / deliveries | 145 / 1,432 | 18 / 162 |
| New sessions/minute | 211.87 | 18.99 |
| Sessions/minute after health probes and cron | 203.87 | 11.99 |
| WAL bytes/minute | 1,149,183 | 327,052 |

Full Home reads follow relevant actions or a rejected partial update. Most official changes use score-only reads.
Forecast-only reads range from zero to ten, according to scheduled delivery.
No full Home read comes from a live-only tick.
The training snapshot is 8,785 decoded bytes and 2,106 gzip bytes at the median.
Held-out uses 15,016 decoded bytes and 3,298 gzip bytes.
The supplied deployed probe measures NBA boxes at 31 KB and ESPN summaries at 448 KB.
No additional deployed probe supports these lab numbers.

## Free-plan budget

The stress model uses ten phones, six hours per night, and thirty nights.
The table takes the largest training or held-out value.
These are projected monthly totals, except database size, memory, disk operations, and peak connections.

| Resource | Projected use or measured peak | Free allowance or reference | Share |
| --- | ---: | ---: | ---: |
| Supabase transfer | 2.682 GB/month | 5 GB/month | 53.65% |
| Supabase Edge invocations | 105,550/month | 500,000/month | 21.11% |
| Realtime messages | 485,737/month | 2,000,000/month | 24.29% |
| Realtime connections | 10 | 200 | 5.00% |
| Database size | 266.14 MB | 500 MB | 53.23% |
| Database memory | 201.24 MB | 500 MB reference | 40.25% |
| Disk operations | 78.08/s | 250/s reference | 31.23% |
| Vercel requests | 264,459/month | 1,000,000/month | 26.45% |
| Vercel invocations, eleven regions | 237,473/month | 1,000,000/month | 23.75% |
| Vercel transfer | 0.872 GB/month | 100 GB/month | 0.87% |
| Vercel origin transfer | 3.566 GB/month | 10 GB/month | 35.66% |
| Vercel active CPU | 0.557 hours/month | 4 hours/month | 13.92% |
| Vercel memory | 1.246 GB-hours/month | 360 GB-hours/month | 0.35% |

Real users likely reach one or two cache regions.
The largest training projection is 21,588 monthly invocations for one region, or 43,177 for two.
The table reserves eleven independent caches.
Vercel CPU and duration come from the local fake feed, not hosted billing.

Transfer uses measured encoded phone bytes and conservatively decoded database-to-Edge bytes.
The unchanged model reserves 16 KiB per recovery check across 10,800 monthly checks.
It adds 300 cold openings and counts both phone and internal transfer legs.
An earlier 455-byte recovery probe does not reduce this reserve.
Headers and TLS overhead are unmodeled.

The [official egress guidance](https://supabase.com/kb/troubleshooting/all-about-supabase-egress-a_Sg_e) describes outgoing bytes and both transfer legs.
It does not explicitly promise API-specific gzip billing.
Local `Content-Encoding` and encoded lengths are verified; hosted compression and billing remain unverified.
The largest fully decoded estimate is 3.508 GB/month, above the half-allowance target.
The named decision uses measured encoded responses, with hosted verification required at rollout.
[Realtime billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) counts a send and each receiving client.

Transfer uses the accepted exception of at most 55%; held-out reaches 53.65%, with narrow remaining headroom.
Database size is the other accepted exception: the production-sized fixture stays unchanged.
Official history does not expire automatically.
See [capacity and retention](db-capacity.md) for growth limits.
The [replay lab](../scripts/bench/game-night/README.md) retains the executable gates and reporting workflow.

## Follow-ups

Three pre-existing cases remain outside this release gate.
The predecessor can accept an incomplete NBA final that omits a player.
Forecast inputs can omit an unfinished prior-day game after Eastern midnight.
An unexpectedly early first game remains undiscovered while no live worker is running.
Public start receipts fix active-worker discovery; they do not start a worker before its admission window.
