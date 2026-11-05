# Release 2.15

Live matchup screens use a shared public snapshot while Postgres retains official results and all league rules.
The snapshot refreshes every 30 seconds while a live screen is visible.
Hidden screens stop polling; stale data falls back to saved scores with a stale state.
Other-team views, final corrections, and private action broadcasts retain their correctness checks.
Unfinished games keep updating after league midnight. Future scheduled players no longer suppress live teammates.
All-Star projection windows span the full scoring week.
Trade analysis permits one daily catch-up after matching pick predictions complete.
Start receipts run across the returned slate before recovery imports.
Their deadlines isolate slow games, reserve import time, and preserve start broadcasts.
Live lines remain tied to their lineup date; unavailable games cannot freeze healthy overlays.

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
Nightly work runs during 04:00–06:00 Eastern without a live-game gate.
Existing Home content stays available offline while its old version counter awaits revalidation.

## Local acceptance

The final runtime sample is `826d2e3be71d433319c519f3a82e977061d0a3b9`.
It measures 20.036 anonymous refaults/s, below 35.09/s, with every quality and budget gate passing.
This is one unpaired final-code sample, 98.96% below the recorded reference median.
The earlier held-out result was 13.976/s on the earlier revision; this final release check does not repeat held-out.
The lab retains the 192 MiB cap, 32 MB shared buffers, pool two, 30-second tick and 30-minute checkpoints.
These are local measurements, not production capacity or billing proof.

## Named risks

The final transfer projection is 2.230 GB/month, or 44.59% of Supabase's 5 GB allowance.
It is below the 50% target; the accepted 55% exception is not needed for this sample.
The unchanged database fixture occupies 53.13% of the 500 MB allowance.
Official statistics and results have no automatic expiry.
Long-term growth requires an explicit history policy or a larger plan.

Hosted acceptance of 32 MB shared buffers and PostgREST pool two still requires read-back during rollout.
If either setting is refused, stop before merging and measure the supported configuration separately.
Local gzip is verified; hosted compression and billed transfer remain rollout checks.
See [live scores](live-scores.md) for the budget model and [capacity](operations-scheduler.md#capacity) for retention.

## Release order and recovery

Database, then Edge, then hosted settings, then merge the frontend.
Enable worker `LIVE_SNAPSHOT_BASE_URL` only after the public route answers on the production URL.
Keep the database ingestion path until old clients and workers finish updating.
Unsetting the worker secret restores ordinary ingestion on new invocations; it does not switch phones.
Phones need a client deployment or the separate Vercel switch to return to database mode.
There is no access to that Vercel account in this work.

The database release guide lists all 26 pending migrations and the generated records.
The operator runbook remains outside the repository because it contains project-specific commands.
Production changes, pushes, and deployment are not part of release preparation.
