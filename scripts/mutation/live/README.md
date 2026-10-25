# Live and weekly scoring mutations

Use the assigned isolated Mac mini checkout and its task environment.
Inputs are synthetic unless a recipe declares a pinned historical source.
Keep catalogs, results, logs, and saved definitions outside the repository when the runner permits an output path.

## Setup and run

The runner requires project `pt4balive`, API port 57321, and database port 57322.
Start that project from the repository migrations.
Serve Edge functions with `supabase-go functions serve --env-file ../edge.env`.
The local Edge environment needs the matching synthetic `PANCAKE_EDGE_INTERNAL_TOKEN`.

```sh
python3 scripts/mutation/live/build_catalog.py
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase baseline --evidence ../evidence
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase tier1 --evidence ../evidence
```

The wrapper reads keys from that stack's CLI status and rejects other targets.
Database recipes default to CI ports 54321 and 54322.
The wrapper sets `PANCAKE_TEST_API_PORT` and `PANCAKE_TEST_DB_PORT` to the assigned ports.
Recipes check protocol, loopback host, and port before writes.

SQL mutations replace deployed definitions without changing migration files.
TypeScript mutations change actual runtime sources in the isolated copy.
Each oracle starts a new process.
The runner restores every changed definition or file and verifies its SHA-256.
A restore failure stops the batch.
Each oracle has a bounded timeout.

`catalog.json` defines mutations and oracle commands.
`results.jsonl` retains commands, exits, durations, and log paths.
`baseline-commands.json` records successful unmutated commands.
Use `--ids L09,W01` to select mutations and `--extra '<command>'` to add an oracle.
Run each added oracle unmutated first.
Keep original results when repeating a mutation; use the latest verdict per identifier for summaries.

## Scoring contracts

Live scoring supplies an input token with every points update.
SQL validates it under row locks before publishing.
Internal callers without tokens retain compatibility, but the application scorer always supplies them.
A stale-token conflict permits one retry after fresh inputs, matchups, and stats reads.
A second conflict, finalization conflict, or unrelated error fails the job.
Telemetry does not control the retry budget.

Regular-season idle gates reuse valid current tokens and compare earlier cumulative week keys.
Playoff schedules and missing tokens use the full comparison.
Consumed playoff results remain frozen while global player stats can continue changing.
The delayed-tipoff selector keeps Scheduled games due through T+45 minutes.
Its later checks use the existing Scheduled-game backoff.

## Focused recipes

| Recipe | Evidence |
| --- | --- |
| `tests/db/weekly-idle-load.sql` | Idle dispatch cost with synthetic leagues and matchups |
| `supabase/tests/db/live-score-load.ts` | Concurrent stat writes, scoring progress, rejection recovery, and finalization |
| `supabase/tests/db/live-score-tick-recovery.ts` | Native worker correlation, stale-token recovery, and unrelated error propagation |
| `supabase/tests/db/scoring-skip-first-week.ts` | Authenticated skipped-week settings, scores, maxima, certificates, and Realtime |
| `tests/db/live-poll-delayed-tipoff.sql` | Extended tipoff window and throttle boundaries |
| `supabase/tests/db/makeup-scoring.ts` | Publisher-driven makeup dates, provider failures, and final redelivery |
| `supabase/tests/db/scoring-all-star-week.ts` | Merged week spans, daily updates, maxima, and certificates |
| `tests/db/calendar-live-marker.sql` | Unknown-date markers, explicit resumption, and immediate board eligibility |
| `supabase/tests/db/scoring-eliminated-lineups.ts` | Eliminated teams, retained lineups, consumed results, and native delivery |
| `tests/db/scoring-idempotent-finalization.sql` | Stable rows on redelivery, real corrections, and stale-token rejection |

The [verification guide](../../../docs/verification.md) covers ordinary local database checks.
The package scripts and `scripts/mutation/post/registrations.json` define current CI and evidence-only recipes.
A recipe outside CI still needs an executed passing baseline before mutation results count.

## Repeatability and paired recovery

The residue helpers seed unrelated state, run recipes repeatedly, and compare retained rows.
Prepare each helper's required original SQL or TypeScript source in its external evidence directory first.
Do not fabricate a missing baseline from the changed implementation.

```sh
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/delayed-residue.py
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/retry-regressions.py
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/makeup-regressions.py
```

`residue.py` supplies seed, red, green, verify, and cleanup phases for chain isolation.
It requires `--evidence PATH` and the assigned local stack.
The chain must preserve unrelated leagues, games, calendars, leases, and invocations.
Rollback-only recipes select unused fixture years and count their own requests.

Historical source measurements remain separate from application correctness.
`tipoff-impact.py` verifies fixture hashes before calculating delay exposure.
`game-night-load.sql` measures a synthetic workload without a wall-clock pass threshold.
These results do not reconstruct historical production latency.

## Eliminated-team checks

The eliminated-lineup recipe uses real calendar shapes with synthetic managers, players, games, and scores.
It drives actual imports, scoring, auto-set, bracket boundaries, certificates, and authenticated Realtime.
It requires consumed rounds to resist later player stats and corrections.
Run selected variants on the assigned stack:

```sh
for year in 2024 2025; do
  for variant in full skip; do
    bash scripts/mutation/live/with-stack.sh deno run --no-lock --check --allow-env \
      --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql \
      supabase/tests/db/scoring-eliminated-lineups.ts "$year" "$variant"
  done
done
```

The recipe restores its clock, cron jobs, and owned fixtures in cleanup.
Realtime checks wait for PostgreSQL subscription confirmation before measuring delivery.
A channel join alone does not prove database registration.
Use `eliminated-catalog.py` to add this area's mutations to the catalog.
