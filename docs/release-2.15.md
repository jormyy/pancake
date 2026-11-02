# Release 2.15

Live matchup screens use a shared public snapshot while Postgres retains official results and all league rules.
The snapshot refreshes every 30 seconds while a live screen is visible.
Hidden screens stop polling; stale data falls back to saved scores with a stale state.
Other-team views, final corrections, and private action broadcasts retain their correctness checks.

## Local acceptance

The final training repeat uses the frozen runtime at `e48cae97`.
Three candidates measure 6.85, 4.04, and 4.73 anonymous refaults/s.
Three paired references measure 1,866, 2,216, and 1,931/s.
The median is 4.73 versus 1,931/s: 99.76% lower.
Every quality gate passes; the deliberately broken final write fails its control.
The final held-out confirmation measures 1.92/s and passes its gates.
These are local synthetic results at a 192 MiB cap, 32 MB shared buffers, and PostgREST pool two.
They are not production capacity or billing proof.
No measurement series is repeated for release preparation.

## Named risks

The ten-phone stress projection reaches 51.0% of Supabase's 5 GB transfer allowance, about 2.55 GB/month.
The final repeat ranges from 49.7% to 51.0%, above the preferred half-limit on one sample.
This margin is accepted for release; it remains below the actual allowance.
The unchanged database fixture occupies about 53% of the 500 MB allowance.
Official statistics and results have no automatic expiry.
Long-term growth requires an explicit history policy or a larger plan.

Hosted acceptance of 32 MB shared buffers and PostgREST pool two still requires read-back during rollout.
If either setting is refused, stop rollout before merging and measure the supported configuration separately.
Local gzip is verified; hosted compression and billed transfer remain rollout checks.
See [live scores](live-scores.md) for the complete budget model and [capacity](db-capacity.md) for retention.

## Release order and recovery

Database, then Edge, then hosted settings, then merge the frontend.
Enable worker `LIVE_SNAPSHOT_BASE_URL` only after the public route answers on the production URL.
Keep the database ingestion path until old clients and workers finish updating.
Unsetting the worker secret restores ordinary ingestion on new invocations; it does not switch phones.
Phones need a client deployment or the separate Vercel switch to return to database mode.
There is no access to that Vercel account in this work.

The database release guide lists all thirteen pending migrations and the generated records.
The operator runbook remains outside the repository because it contains project-specific commands.
Production changes, pushes, and deployment are not part of release preparation.
