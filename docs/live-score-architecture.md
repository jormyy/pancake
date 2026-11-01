# Shared live scores

The local replay validates shared snapshots, phone scoring, and official checkpoints. [Measured results](half-gig-results.md) separate code changes, runtime settings, quality checks, and remaining free-plan risks. No deployment has occurred.

## Public route

`GET /api/live/YYYY-MM-DD` reads public NBA and ESPN feeds. It accepts today or yesterday in Eastern Time. It never reads Supabase or forwards request credentials. The payload contains game IDs, team codes, clocks, source times, and compact player lines. It contains no league or user data.

The root `api/live/[date].ts` function runs beside the static Expo output. Its rewrite precedes the static fallback. Vercel supports an `api` directory with a separate output directory. See [build configuration](https://vercel.com/docs/builds/configure-a-build).

Responses use `s-maxage=30`, `stale-while-revalidate=15`, and `stale-if-error=90`. Concurrent origin requests share one fetch. Vercel does not enforce `stale-if-error` for server-side caching. The origin keeps at most two last-good daily responses as a best-effort error fallback. It preserves their source times and stops serving them after two minutes. A cold instance without a saved response returns an uncached error. The lab models this behavior and does not pretend the CDN supports error reuse. Phones must reject snapshots older than two minutes, even if a CDN returns them. See [cache directives](https://vercel.com/docs/caching/cache-control-headers).

`LIVE_SCORES_OFF=1` selects database mode. The route then returns no player lines and makes no upstream requests. Worker and phone integration must honor this same response.

The Edge worker reads the public origin configured by `LIVE_SNAPSHOT_BASE_URL`. Without that origin, it retains legacy ingestion. With it, the worker checks the shared snapshot every thirty seconds. It saves game transitions, verified finals, and thirty-minute recovery checkpoints. The existing final-correction schedule remains.

The same server response controls both phones and workers. Database mode restores per-tick ingestion and the prior twenty-second screen-recovery check. Public mode uses a two-minute saved-screen check. Realtime still invalidates changed scores and actions immediately. An environment switch takes effect when the hosting service applies it; an existing CDN entry can then persist through its normal cache interval.

The route rejects bodies above 1 MB. This is below the 4.5 MB function response limit and the 10 MB non-streaming cache limit. See [function limits](https://vercel.com/docs/functions/limitations) and [CDN cache limits](https://vercel.com/docs/caching/cdn-cache).

Each player line has fifteen values: provider ID, points, rebounds, assists, steals, blocks, turnovers, made threes, made field goals, attempted field goals, made free throws, attempted free throws, fouls, minutes, and DNP. These cover the shared scoring formula and displayed box-score fields. Unused offensive rebounds, defensive rebounds, attempted threes, and plus/minus are omitted.

## Source and payload measurements

Michael's completed Vercel probe returned NBA scoreboard 22 KB in 89 ms and NBA box score 31 KB in 198 ms. ESPN returned 169 KB in 126 ms and 448 KB in 27 ms. Its cache moved from MISS to HIT. That single quiet-slate observation does not prove sustained live access. No further deployment was made.

The route now tries a validated NBA box before an ESPN summary. It still reads both scoreboards to check freshness and identity. It fetches an ESPN summary only when NBA cannot meet those checks. A local matched-game test reduces four source calls and 3,130 bytes to three calls and 2,148 bytes, with identical output.

A later local public-feed check returned an NBA scoreboard of 22,261 bytes. ESPN returned HTTP 403. The requested day had no games. Its 230 ms wall time and 29 ms CPU are a single local observation, not a live-game or Vercel billing measurement.

The authorized home response falls from 82,288 to 57,549 raw bytes and 7,680 to 6,510 gzip bytes. It retains all matchup starters and only the displayed matchup's bench. The measured fixture drops from 200 to 104 basis rows. It adds no screen read. The omitted-bench control fails before this change.

## Initial source measurement

The local source probe returned seven games on November 1, 2026: 11,400 bytes raw, 3,463 bytes gzip, and 350 ms wall time. The evidence is `evidence-climb/provider-connectivity.json`. This proves source access from this Mac. It does not measure a live Vercel function.

Removing four unused values reduces the frozen seven-game response from 10,196 to 8,768 bytes. Gzip falls from 2,326 to 2,040 bytes. That is 14.0% less raw data and 12.3% less compressed data. This comparison changes no scoring input. Evidence is `evidence-climb/public-runtime-smoke/payload-trim.json`.

Phones poll at cache expiry, about every thirty seconds. One short retry reads a completed background refresh after a stale response. Ten phones, six hours per night, thirty nights produce at most 432,000 phone requests. The worker adds 21,600 requests. At the measured median of 8,788 raw and 2,129 gzip bytes, the combined bound transfers 3.986 GB raw or 0.966 GB gzip. These are projections, not hosted billing measurements.

With one shared cache region, thirty-second misses produce at most 21,600 origin calls during those hours. Eleven independent regions produce at most 237,600. That upper estimate transfers 2.088 GB of raw origin responses. Cache outages can increase calls; the request total remains the conservative upper bound.

Current [Hobby allowances](https://vercel.com/docs/plans/hobby) include one million CDN requests, one million function invocations, 100 GB transfer, 10 GB origin transfer, four active CPU hours, and 360 GB memory-hours. Request and transfer estimates are below half those allowances. Each replay also projects CPU and memory from local route measurements. Those projections do not establish deployed resource usage. Public traffic beyond these ten phones is outside this estimate.

## Validation

The route tests cover source fallback, public-only output, the off switch, invalid requests, source errors, request coalescing, and routing order. The local cache tests cover thirty-second expiry and bounded stale responses. The core overlay tests cover starter deltas, source identity, stale fallback, duplicate rows, invalid lines, and official finals. Ten simulated pollers share the same cache in a clock-controlled check. Every observed change arrives within 45 seconds, with no more than two requests per cache interval. Polling stops while hidden, offline, or without live games. Reopening and reconnecting fetch immediately.

The unchanged ingestion path remains available for the off switch and official saves. It must not be removed while the switch depends on it.

`live-poll/runner.ts`, its source fallback, player-resolution routines, live-feed caches, and save functions remain necessary for checkpoints and verified finals as well as database mode. The old per-tick branch remains specifically for database mode. Safety and permission triggers remain active on every official save.

## Local replay

`node scripts/bench/game-night/runtime-check.mjs` starts a disposable stack and tests the public route, ten authenticated subscribers, and both worker modes. It stops the stack afterward. This fixed-state check is not a performance result.

`node scripts/bench/game-night/run.mjs --public-live --quality --policy --pool 2 --evidence <outside-repo-directory>` runs the training replay. Use `--phones` with the original source checkout for the paired baseline. Both runs use the same phone overlay, HTTP cache, and fixture. The public server has no Supabase environment variables or access permissions.

The timed window still uses 192 MiB. After it ends, the feed holds its last state while scheduled checkpoints settle. That work stays outside the measured counters. Final-state checks then compare official stats and scores with the unchanged fixture. Reports retain stored-score freshness separately from phone freshness. The new work grader requires due checkpoints, final transitions, actual saves, worker starts, cache misses, and phone requests inside the timed window.

Focused cache and phone tests cover outages, stale snapshots, hidden screens, reconnecting, and opening mid-game. Deliberately late scores, wrong final scores, missing subscribers, missing checkpoints, and disabled ingestion fail their graders. The repeated comparison and explicit fault controls are recorded separately. They retain their source hashes and original failed reports.

## Saved-score basis

Home returns authorized lineup IDs and saved contributions with its existing screen read. A consistency check compares saved stat totals with official matchup totals. Phones show saved scores until those totals agree. A saved final never accepts another live delta. Later official corrections remain visible. Past-day screens omit the live basis. Other-team screens select the requested league matchup while retaining the viewer authorization check.


## Free-plan accounting

Reports project the measured peak window across ten phones, six hours per night, thirty nights. They count worker polling as well as phone polling. A second bound allows eleven separate CDN regions. Normal cache hits cost requests and transfer but do not invoke the function. The fixed route cap is 1 MB; measured snapshots are much smaller.

| Service | Resource | Free allowance | Half allowance |
| --- | --- | --- | --- |
| Vercel Hobby | CDN requests / function invocations | 1,000,000 each | 500,000 each |
| Vercel Hobby | Fast data / origin transfer | 100 GB / 10 GB | 50 GB / 5 GB |
| Vercel Hobby | Active CPU / allocated memory time | 4 hours / 360 GB-hours | 2 hours / 180 GB-hours |
| Supabase Free | Database / egress | 500 MB / 5 GB | 250 MB / 2.5 GB |
| Supabase Free | Edge invocations | 500,000 | 250,000 |
| Supabase Free | Realtime messages / peak connections | 2,000,000 / 200 | 1,000,000 / 100 |

The current sources are [Vercel limits](https://vercel.com/docs/limits) and [Supabase quotas](https://supabase.com/docs/guides/platform/billing-on-supabase). Supabase [Nano compute](https://supabase.com/docs/guides/platform/compute-and-disk) provides up to 0.5 GB memory and 250 baseline disk operations per second. Disk operations are a sustained baseline, not a monthly quota.

Named risk: database size and retention. The unchanged 265 MB fixture already uses about 53% of the 500 MB allowance. Reports retain actual before/after database allocation and table sizes. A short allocation increase includes reusable pages and does not predict permanent monthly growth. Official stats and results stay protected; successful-job and broadcast history retain their bounded cleanup. Real hosted growth remains unmeasured because this work never reads production.

A physical phone, sustained live provider access from Vercel, deployed cache behavior, and deployed CPU billing remain rollout checks. The local browser uses the real exported app at a 390-pixel viewport. It verifies saved-score fallback without horizontal overflow or script errors. Ten authenticated replay clients verify official corrections through actual Realtime broadcasts; an omitted correction fails their expectation.

## Accepted runtime setting

The combined replay uses 32 MB `shared_buffers` and a PostgREST pool of two connections. The [settings guide](half-gig-settings.md) gives the separate hosted controls. These values are not applied by a schema migration.

The replay keeps Realtime, Auth, Storage, cron, and `pg_net`. The old ingestion branch and unfiltered checkpoint reader remain for database mode. The live worker also needs its identity checks and save functions for final results and corrections.

The decoded Supabase transfer projection remains a named risk. It repeats the heavy action rate across every playing hour and includes database-to-Edge plus Edge-to-phone responses. Keep both legs visible; do not call this hosted billing data.
