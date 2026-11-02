# Release 2.15

Live matchup screens use a shared public snapshot while Postgres retains official results and all league rules.
The snapshot refreshes every 30 seconds while a live screen is visible.
Hidden screens stop polling; stale data falls back to saved scores with a stale state.
Other-team views, final corrections, and private action broadcasts retain their correctness checks.

## Review corrections

Public workers discover early starts and recover due official imports without the shared route.
One unavailable game cannot block healthy games or advance failed checkpoints.
ESPN completion requests authoritative final checks; DNPs remain distinct from missing lines.
Phones reject older game revisions and keep the selected week in multi-week matchups.
Late corrections cannot starve forecasts; cancelled and stale games cannot block nightly jobs.
Legacy clients retain league events. Canonical requests share a bounded origin refresh.
Home reads only changed scores or forecasts and keeps saved lineups.
Official writes retain the existing per-game ingestion and NBA final certification.
An incomplete NBA final can still omit a player, as on the predecessor; this remains a follow-up.
Stale public games use short recovery; slow failures cannot keep later games from recovery.
Exact decimal scoring matches SQL, including custom settings.
Temporary live-game gates retry during the same nightly window.
Existing Home content stays available offline while its old version counter awaits revalidation.

## Local acceptance

The measured runtime is `cd24bce935b02493a065835c2f3a36b5d6c00f18`.
Three candidates measure 6.688, 3.668, and 27.059 anonymous refaults/s.
Their median is 6.688 versus the recorded reference median of 1,930.923/s: 99.65% lower.
The comparison is unpaired and keeps the fixed 35.09/s ceiling.
Every quality gate passes; the deliberately dropped final stat fails its control.
The one final held-out confirmation measures 13.774/s, below 158.37/s, and passes all gates.
These are synthetic local results at a 192 MiB cap, 32 MB shared buffers, and PostgREST pool two.
They are not production capacity or billing proof.

## Named risks

The largest transfer projection is 2.746 GB/month, or 54.91% of Supabase's 5 GB allowance.
It fits the accepted 55% exception with narrow remaining headroom.
The unchanged database fixture occupies about 53.14% of the 500 MB allowance.
Official statistics and results have no automatic expiry.
Long-term growth requires an explicit history policy or a larger plan.

Hosted acceptance of 32 MB shared buffers and PostgREST pool two still requires read-back during rollout.
If either setting is refused, stop before merging and measure the supported configuration separately.
Local gzip is verified; hosted compression and billed transfer remain rollout checks.
See [live scores](live-scores.md) for the budget model and [capacity](db-capacity.md) for retention.

## Release order and recovery

Database, then Edge, then hosted settings, then merge the frontend.
Enable worker `LIVE_SNAPSHOT_BASE_URL` only after the public route answers on the production URL.
Keep the database ingestion path until old clients and workers finish updating.
Unsetting the worker secret restores ordinary ingestion on new invocations; it does not switch phones.
Phones need a client deployment or the separate Vercel switch to return to database mode.
There is no access to that Vercel account in this work.

The database release guide lists all 31 pending migrations and the generated records.
The operator runbook remains outside the repository because it contains project-specific commands.
Production changes, pushes, and deployment are not part of release preparation.
