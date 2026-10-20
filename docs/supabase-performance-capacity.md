# Database performance contracts

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

Health-filtered player search reuses score rows within its statement.
Other searches keep the direct view path.
This adds no stored cache or new source authority.

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
