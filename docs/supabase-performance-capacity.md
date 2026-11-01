# Database performance

These contracts define scoring reuse, bounded reads, and local capacity measurements.
Recovery preserves database objects and current source data.

## Scoring

Scoring reuses certified closed-week maximum points when the input certificate remains valid.
Cold repair and invalid certificates still run the exact search.
Stale-week detection checks each distinct week before expanding its result.
Stat corrections, IR history, and scoring settings remain inputs to correctness.
Run `npm run test:db:skipped-week-certificates` for the closed-week regression.

The projection query selects the next regular-season game once per requested team within each statement.
It keeps season, date, team, regular-season filtering, and game ordering intact.
It creates no persistent snapshot.
Trade veto reads check `private.can_read_trade(trade_id)` directly for each veto row.
They retain the existing participant and league access rules.

Current-season player search reads stored player averages through the screen view.
Historical searches retain their season-specific calculations.
The database remains the source of official scoring and ownership.
Visible live screens overlay [public snapshots](live-scores.md); they do not change official results.

## Measurements

The [benchmark guide](../scripts/bench/README.md) owns setup, fixtures, clocks, and comparison commands.
The profiler measures authenticated reads and local job handlers against synthetic data.
Its fixed fixture represents a dense capacity workload, not an average NBA week.
Provider responses can be pinned. Such results do not measure internet latency or new-stat ingestion.
Host Deno execution excludes hosted Edge startup and CPU quotas.
Summed nested statement time does not measure CPU time.
With five observations, nearest-rank p95 equals the largest observation.

Confirm equal outputs before comparing measurements.
Save raw samples, source hashes, statement snapshots, and plans outside the checkout.
Run `npm run bench:profile:report -- <input-json> <output-markdown>` to render a saved profile.
The [verification guide](verification.md#capacity-profile-and-paired-scoring) defines reporting requirements.

## Retained recovery sources

Projection lookup recovery replaces the function with its prior canonical definition and reloads the PostgREST schema.
Replacement preserves the function identity, grants, and dependencies. Do not drop the function.
Trade-veto policy recovery restores its prior statement from `supabase/migrations/20260328000004_rls_policies.sql` in one bounded transaction.
Neither recovery restores old data or bypasses the attested release checks.

## Production beacons

Web screen opens record time until useful content has a paint opportunity.
Cold means the first supported screen after a document starts. Later opens are warm.
The first reading includes authentication and membership loading time.
Later readings start at the navigation state change.

The check requires the current screen and visible content outside busy, hidden, or inert regions.
It excludes navigation, headings, loading text, and status notices.
Player search also requires its search input and a player count.
Player details require averages or a game log.
The same content node and text must survive two animation frames.
DOM changes trigger checks. Checks stop after one reading, navigation, or two minutes.
Unsupported routes and native screens send no reading. Native views lack this browser paint evidence.

Each reading includes completed fetch and XHR requests within that timing window.
Requests that start before navigation or finish after useful content do not count.
Bytes use Resource Timing `transferSize`, including response headers.
Cached and cross-origin responses can hide their byte size.
`bytes_complete` is false when any counted request reports zero bytes.
Browser resource-buffer limits can omit older requests. These readings are diagnostics, not billing records.

The client keeps at most 20 readings in memory.
It sends one JSON POST to `/beacons` per minute, at most.
Each body stays below 8 KB. A full queue discards its oldest readings.
The request runs outside screen rendering and stops after five seconds.
Offline operation drops readings. Failed sends have no retry or persistent queue.
Signing out or changing membership drops the pending batch.

`EXPO_PUBLIC_PERF_SAMPLE_N` sets a build-time sampling denominator. Its default is 1.
After 20 screen opens per minute, the client samples at most one in ten.
Each sampled row stores its denominator in `sample_n`.
Random sampling applies separately to each open. Small samples can vary.
Summary percentiles describe retained readings without weighting them by the denominator.

The route requires a valid session and ownership of the supplied member ID.
It accepts 1–20 rows and rejects extra fields, unknown screens, and invalid values.
Database constraints repeat the value checks. Browser roles cannot insert or read the table directly.
Only the service role can read `public.perf_summary(p_days)`, with 1–30 UTC calendar days.
It returns sample count and interpolated p50/p95 milliseconds per screen per UTC day.

The table stores no personal data beyond member ID.
It stores fixed screen names, timings, counts, coarse device and connection classes, app version, and sampling rate.
It stores no URL, query string, screen text, player ID, email, user agent, or network name.
The server supplies the receive time. Deleting a membership deletes its readings.
The existing retention job runs daily and deletes readings older than 30 days.
The receive-time index supports that deletion. Rows can remain until the next daily run.

Run the focused checks:

```sh
npx vitest run tests/lib/perf-beacon.test.ts tests/db-function-source-parity.test.ts
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/perf-beacons-validation.sql
deno check supabase/functions/api/index.ts supabase/functions/api/beacons/beacons.test.ts
deno test --allow-env --allow-net=127.0.0.1 --allow-read supabase/functions/api/beacons/beacons.test.ts supabase/functions/api/router.test.ts
node supabase/functions/api/beacons/browser-check.mjs
npm run check:db-function-sources
npm run check:db-function-catalog
npm run check:database-types
```

Run database and browser checks on a private local stack.
The browser recipe uses its own automation session and binds its fixture server to loopback port 59581.
