# Live and weekly scoring mutations

Run on the assigned Mac mini copy only. Inputs are SYNTHETIC.

Start `pt4balive` from the repository migrations with API 57321 and database 57322.
Use the task environment and the repository database harness.
Serve Edge functions with `supabase-go functions serve --env-file ../edge.env`.
The local file contains only `PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token`.

```sh
python3 scripts/mutation/live/build_catalog.py
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase baseline --evidence ../evidence
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/run.py --phase tier1 --evidence ../evidence
```

The runner refuses other API and database targets before applying mutations.
It changes deployed SQL definitions or the actual runtime TypeScript files.
Each SQL change overlays the database without changing migration files.
Each oracle runs in a new process, so TypeScript mutations need no server restart.
The runner restores each definition or file and checks its SHA-256 hash.
The runner stops if restoration fails.
It enforces a 120-second timeout for each oracle.

`catalog.json` records source locations, operators, changes, and oracle commands.
`results.jsonl` records every attempt, command, exit code, duration, and log path.
`baseline-commands.json` records the exact commands that pass before mutation.
Run baseline again after strengthening checks.
Use `--ids L09,W01` to repeat selected mutations.
Use `--extra '<command>'` to add an oracle, after its baseline passes.

Keep initial results separately before repeating mutations.
Append new results to `results.jsonl` and retain earlier rows.
Use the latest verdict per identifier when calculating current scores.
Keep raw evidence outside the repository.

The final catalog uses strengthened checks.
The evidence retains the initial oracle results and their weaker coverage.
The idle scoring regression needs the additive migration in this change.
The overlap regression pauses a real database read while a newer scorer publishes.
Live scoring attaches its captured input token to every points update.
SQL validates supplied tokens under row locks before publishing points.
Untokened internal RPC calls retain their existing behavior for compatibility.
The application scorer always supplies tokens.

`weekly-idle-load.sql` measures the gate with 30 leagues, 360 teams, 90 seasons,
and 11,880 matchups. It rolls back every synthetic row.

`scoring-skip-first-week.ts` uses the authenticated settings RPC to skip week 1.
Its 28-week calendar starts on 2026-10-19 and includes the October opening games.
It checks the real REST API and Realtime stream, week-2 maxima, and certificates.
`weekly-skip-idle.sql` covers the timer gate for the first eligible week.

`live-score-load.ts` writes stats every 1.5 seconds for three minutes.
It runs scoring every twenty seconds, matching the live worker cadence.
It checks rejection recovery, continued progress, and finalization during writes.

The idle gate reuses one current token per wholly regular-season schedule.
Regular matchups cover one week, as enforced by the database constraint.
Earlier tokens retain all common keys and only their own cumulative week keys.
Playoff schedules and missing current tokens use the full comparison.
The gate recipe checks earlier stale certificates and playoff spans independently.

Live polling permits one retry when the points RPC returns its exact stale-token error.
The scorer captures inputs and reads stats again before that retry.
The worker reports scoreRetries and logs the retry with its league and week.
A second conflict or any other error keeps the worker failure signal.
Other scoring callers retain their strict behavior unless they opt into this retry.

The native tick recipe checks real worker correlation and database reconciliation.
Its dispatch and transport-response records are SYNTHETIC; its worker and SQL functions are real.
It checks both a recovered stale publication and an unrelated PT409 database error.
The recipe uses actual tick timing and belongs among evidence scripts.
The three-minute writer and gate-load recipes also remain outside the CI database chain.

Database recipes default to CI ports 54321 and 54322.
PANCAKE_TEST_API_PORT and PANCAKE_TEST_DB_PORT select another local test stack.
The wrapper and mutation runner set these to 57321 and 57322.
Their own assigned-stack guards stay fixed.
Recipe guards validate protocol, loopback host, and exact expected port before writes.

The chain residue check uses the real npm recipes and committed SYNTHETIC fixtures.
Save the pre-fix SQL files as before-NAME.sql in the external evidence directory.
Run residue.py with --phase seed, then --phase red before revising recipes.
Run --phase green to execute all five chain entries twice without resetting.
Run --phase verify after targeted mutations and --phase cleanup afterward.
Every phase requires --evidence PATH and the assigned mini loopback stack.
Snapshots verify the unrelated league, stale certificate, live games, calendars,
lease, and invocation survive every recipe and mutation oracle unchanged.
The gate recipes isolate fleet work inside BEGIN/ROLLBACK and count their own requests.
They and the point-guard recipe select an unused calendar year.

The delayed-tipoff selector keeps Scheduled games due through T+45 minutes.
The worker uses needs_scoreboard from that selector to continue its ticks.
After T+45, the existing thirty-minute Scheduled backoff resumes.
The pinned season has 1,230 games; the largest measured tip delay is 35.14 minutes.
The distribution helper verifies each decompressed PBP payload against its manifest hash.
Its overlap counts describe exposure under the old T+10 cutoff, rather than historical app observations.

```sh
python3 scripts/mutation/live/tipoff-impact.py --fixtures "$TASK/lanes/sim/fixtures" --output ../evidence/round7/tipoff-impact.json
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/delayed-residue.py
bash scripts/mutation/live/with-stack.sh bash -c 'psql "$SUPABASE_DB_URL" -X --set ON_ERROR_STOP=1 -f scripts/mutation/live/game-night-load.sql'
```

The residue helper commits one unrelated InProgress game and one Scheduled game.
It runs the registered delayed-tipoff recipe twice, checks their unchanged hashes, and deletes only those two games.
The game-night benchmark measures twelve late Scheduled games and rolls back all rows.
It records timing without asserting a wall-clock threshold and stays outside CI.
L32–L39 cover the extended window, throttle boundaries, and the actual worker continuation policy.
