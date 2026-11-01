# Live scores

## Data contract

The public route `GET /api/live/YYYY-MM-DD` returns compact NBA game lines.
It accepts today and yesterday in Eastern time.
It reads no Supabase data, credentials, lineups, or user information.
NBA box scores are preferred; ESPN remains the checked fallback.
Identity, completeness, and source-order checks apply before publication.
Each player line contains only the fields needed by the shared scoring formula.

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
Completed official games use saved results, without a public delta.
Past days remain available from saved views; the public route is not a history service.
A snapshot over two minutes old, or unavailable, shows saved scores with a stale state.
Opening a live screen and reconnecting start a fresh read.

Postgres receives status transitions, final statistics, corrections, and recovery checkpoints every 30 minutes.
A normal checkpoint preserves version history but sends no live-only broadcast.
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
| PostgREST pool 2 | Management API `PATCH /v1/projects/{ref}/postgrest` with `{"db_pool":2}` | Read the service configuration and observe connections; this is separate from Supavisor |

The [Postgres guide](https://supabase.com/docs/guides/database/custom-postgres-config) requires organization Owner or Administrator access.
The [PostgREST endpoint](https://supabase.com/docs/reference/api/v1-update-postgrest-service-config) requires `rest:write` or `data_api_config_write`.
Neither document lists a Free-plan exclusion for these controls.
Actual hosted acceptance and read-back remain unverified.
Keep the previous values for rollback; CLI updates replace configured defaults.
No hosted setting changes occur during local measurement.

The connection trace finds three short Auth database sessions per authorized Home read.
The PostgREST data pool persists during those reads.
Fewer necessary screen reads remove Auth churn without caching authorization or shortening connection lifetime.
Pool three has no demonstrated benefit for this cause.

## Lab results

These are local synthetic results, not production capacity or billing proof.
The reports use `game-night-cgroup-v1` and the fixed 192 MiB cap.
The primary measure is the database cgroup's `workingset_refault_anon` delta per second.
VM swap counters remain diagnostics; the kernel exposes no normal per-cgroup swap-out rate.
A sample fails host isolation below 1 GiB VM available memory.
Foreign containers are recorded and left unchanged.

| Sample | n | Median anonymous refaults/s | Range |
| --- | ---: | ---: | --- |
| Paired reference | 3 | 2,083.325 | 2,042.079–2,147.293 |
| Training before final heartbeat repair | 3 | 4.822 | 4.464–9.429 |
| Held-out reference | 3 | 3,167.493 | 3,114.448–3,432.218 |
| Final held-out confirmation | 1 | 1.920 | Single sample |

The training reduction is 99.77%; its strict ceiling is 35.092/s.
The held-out ceiling is 158.375/s.
Training uses source `8d8ff1cc`; held-out uses `e48cae97` after the heartbeat repair.
Three training runs on that final repair remain pending in the recorded report.
Do not describe the final source as having passed repeated training until that separate series finishes.
The held-out run is a final confirmation after earlier use, not a fresh untouched tuning set.
Settings alone measured 142.640/s against 701.832/s, each with n=3 and without phones.
Those gains are not additive.

All three training samples pass their recorded action, final-state, freshness, schedule, and failure gates.
Phone freshness p95 is 29.408 seconds at the median, with a maximum sample of 31.079 seconds.
Held-out phone freshness p95 is 29.378 seconds.
The ten-phone correction test reaches all phones in 560 ms.
Broken final statistics, disabled ingestion, slow actions, suppressed broadcasts, missing forecasts, and wrong phone finals fail their gates.

| Per four-minute window, unless stated | Previous architecture | Current architecture |
| --- | ---: | ---: |
| Provider calls | 75 | 75 |
| Provider bytes | 1,372,190 | 1,372,138 |
| Database API calls | 343 | 165 |
| Home reads | 90 | 14 |
| Mean Home decoded bytes | 56,716 | 28,290 |
| Current mean Home gzip bytes | Unmeasured | 4,892 |
| Phone decoded bytes | 5,105,006 | 396,066 |
| Current phone wire bytes | Unmeasured | 68,484 |
| Edge invocations | 111 | 24 |
| Broadcast sends / phone deliveries | 26 / 240 | 16 / 142 |
| New sessions/minute | 83.46 | 19.24 |
| Sessions/minute excluding health probes and cron | 76.46 | 12.24 |
| WAL bytes/minute | 302,425 | 299,738 |

Four Home reads serve roster changes; ten serve official game or stat changes.
No timed Home read comes from a live-only tick.
The median snapshot is 8,788 decoded bytes and 2,130 gzip bytes.
The supplied deployed probe measures NBA boxes at 31 KB and ESPN summaries at 448 KB.
No additional deployed probe supports these lab numbers.

## Free-plan budget

The stress model uses ten phones, six hours per night, and thirty nights.
These are projected usage totals, except database size, memory, disk operations, and peak connections.
The table uses the largest training or held-out value.

| Resource | Projected use or measured peak | Free allowance or reference | Share |
| --- | ---: | ---: | ---: |
| Supabase transfer | 2.425 GB/month | 5 GB/month | 48.49% |
| Supabase Edge invocations | 81,260/month | 500,000/month | 16.25% |
| Realtime messages | 456,034/month | 2,000,000/month | 22.80% |
| Realtime connections | 10 | 200 | 5.00% |
| Database size | 267.06 MB | 500 MB | 53.41% |
| Database memory | 201.23 MB | 500 MB reference | 40.25% |
| Disk operations | 51.80/s | 250/s reference | 20.72% |
| Vercel requests | 261,761/month | 1,000,000/month | 26.18% |
| Vercel invocations, eleven regions | 237,488/month | 1,000,000/month | 23.75% |
| Vercel transfer | 0.854 GB/month | 100 GB/month | 0.85% |
| Vercel origin transfer | 3.567 GB/month | 10 GB/month | 35.66% |
| Vercel active CPU | 0.43 hours/month | 4 hours/month | 10.75% |
| Vercel memory | 0.93 GB-hours/month | 360 GB-hours/month | 0.26% |

Real users likely reach one or two cache regions.
Training projects 21,588 monthly invocations for one region, or 43,175 for two.
The table reserves eleven independent caches.
Vercel CPU and duration come from the local fake feed, not hosted billing.

Transfer uses measured encoded phone bytes and conservatively decoded database-to-Edge bytes.
The recovery reserve is 2 KiB per call across 10,800 monthly checks, plus 300 cold openings.
A separate probe measures 455 combined bytes for the phone, Auth, and version RPC.
Its rule adds 1 KiB and rounds upward, with a 2 KiB minimum.
That probe's cold waiver misses its latency limit; it is byte evidence only.
Original reports keep their older 16 KiB reserve; the separate projection ledger records the adjustment.
Headers and TLS overhead are unmodeled.

The [official egress guidance](https://supabase.com/kb/troubleshooting/all-about-supabase-egress-a_Sg_e) describes outgoing bytes and both transfer legs.
It does not explicitly promise API-specific gzip billing.
Local `Content-Encoding` and encoded lengths are verified; hosted compression and billing remain unverified.
The fully decoded upper bound is 3.378 GB/month, above the 50% target.
The named budget decision uses measured encoded responses, with hosted verification required at rollout.
[Realtime billing](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) counts a send and each receiving client.

Database size is the named exception to the half-allowance goal.
The production-sized synthetic fixture stays unchanged and official history does not expire.
See [capacity and retention](db-capacity.md) for growth limits.
The [replay lab](../scripts/bench/game-night/README.md) retains the executable gates and reporting workflow.
