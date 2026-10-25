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
All scoring callers receive one bounded retry; onPublicationRetry supplies optional telemetry.

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

The retry budget is independent of telemetry.
A points conflict captures fresh inputs and reads matchups and stats again.
Consumed playoff rows are then excluded by the normal scoring path.
The second points conflict and every finalization conflict still fail the job.
The overlap recipe observes the actual SQL rejection and confirms stats reads of 20, 80, and 80.
It requires the newer score to remain 80 after the older scorer recovers.

```sh
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/retry-regressions.py
```

The helper runs the thirteen round-eight database targets twice, without resetting between runs.
The origin control belongs only on the unfixed integration copy.
It temporarily omits the L-B2 input-token field, runs playoff-consumption, and restores the file hash.
It does not remove any certificate check from the shipped scorer.
L40 restores callback-gated retry. L41 re-enables a second retry.
Their unit oracle checks default callers, callback counts, fresh tokens and points, strict error types, and the two-attempt bound.

The postponed-game recipes use C1 availability from the deployed score-input query.
Their provider commits confirmation during a native box request to reproduce recovery races.
Available 500 responses, transport timeouts, live games, and unknown Scheduled games keep weeks open.
The same-week and cross-week examples reconstruct pinned ESPN dates with synthetic players and points.
They retain player stat IDs and require unchanged certificates on identical final redelivery.
The cross-week case includes a two-week fantasy final and a never-played cancellation.

The merged-week recipe seeds C2 ranges directly for 2024-25 and 2025-26.
Four cases cover fourteen daily score updates, maxima, certificates, real Realtime delivery,
and the next week, with and without skipped week 1 through the authenticated settings RPC.
The fourteen daily games are synthetic stress inputs, including the calendar's no-game break days.
They do not claim historical daily games during the All-Star break.
Finalization waits until the stored end day ends, even before later schedule rows arrive.
Already-finalized regular weeks retain their legacy correction path.

```sh
bash scripts/mutation/live/with-stack.sh deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/makeup-scoring.ts
bash scripts/mutation/live/with-stack.sh deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/scoring-all-star-week.ts
bash scripts/mutation/live/with-stack.sh python3 scripts/mutation/live/makeup-regressions.py
```

The helper runs the thirteen round-nine neighbors twice without a reset.
New mutation areas use live-pp-01–04 and live-as-01–03 identifiers.
The complete postponed recipe includes a native timeout fault and belongs in evidence checks.
The merged-week recipe asserts data and stream delivery, with no wall-clock performance threshold.
It remains an evidence check because it requires native stream delivery within a deadline.


The live scoreboard keeps a confirmed unavailable marker when a Scheduled snapshot has available-looking text.
Blank, null and tipoff text cannot establish a new game date.
InProgress or Final snapshots still clear that marker when their incoming text permits play.
The schedule publisher can re-date the same provider ID and clear the marker before the makeup tipoff.
The marker recipe verifies that the resulting Scheduled game becomes board-due immediately.
The makeup recipe now uses the actual schedule publisher instead of a direct date update.
Its same provider ID retains one database game, three player stat IDs and one played-week score.

`tests/db/calendar-live-marker.sql` uses an unused fixture year and checks only its own game.
Every fixture write rolls back. Its polling times are explicit, and it asserts no wall-clock threshold.
It can join the database CI chain after the orchestrator registers the command.
`marker-proposal.py` belongs only on the pre-fix stack: it trials the proposal with native oracles,
then restores the deployed function and verifies its original definition hash.
live-pp-05 reverses Scheduled eligibility; live-pp-06 removes that condition and blocks a real resumption.

The merged-week evidence recipe now waits for the native PostgreSQL subscription confirmation and the channel join.
The join alone can precede registration and miss early scoring writes on a cold local stack.
Every score, certificate and final event assertion stays in place.


## Eliminated teams and persisted lineups

`supabase/tests/db/scoring-eliminated-lineups.ts` exercises the actual live tick, stat importer, scorer,
auto-set service RPC, automatic bracket boundaries, PostgreSQL certificates and authenticated Realtime.
The two pinned ESPN calendars are REAL-DERIVED. League members, players, games and stat lines are SYNTHETIC.
It derives 24 fantasy weeks with the production calendar function, keeps merged week 17, and uses rounds [1,2,2] from week 20.
An eight-team league has six playoff entrants, two byes and two non-playoff teams.
All eight teams retain explicit and real auto-set lineups throughout the playoff dates.
Excluded players receive large later stat lines; the final loser also receives two post-champion corrections.

Run each variant twice on the assigned isolated stack:

```sh
for year in 2024 2025; do
  for variant in full skip; do
    for repeat in 1 2; do
      bash scripts/mutation/live/with-stack.sh deno run --no-lock --check --allow-env \
        --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql \
        supabase/tests/db/scoring-eliminated-lineups.ts "$year" "$variant"
    done
  done
done
```

Expected ports default to CI values 54321/54322 and accept PANCAKE_TEST_API_PORT/PANCAKE_TEST_DB_PORT overrides.
The live wrapper selects the assigned ports 57321/57322. It reuses the repository's season-sim clock installation and restoration SQL.
It saves and restores its own stack's cron jobs, restores the native clock and removes its owned fixtures in finally.
The JavaScript clock uses the existing virtualDate helper. Each ingestTick acquires and releases the actual live lease.
Games before bracket creation use the actual completed-box importer; later dates use live and final ticks.
It never changes the replay stack, its clock, source or shared files.
Realtime checks wait for the actual PostgreSQL subscription and a real score publication before measuring later events.
The final check combines unchanged physical rows with a WebSocket acknowledgement after the final-loser imports.

The client-visible check uses authenticated PostgREST with the same week-span filters as lib/scoring.ts.
Certificates and result revisions are season/week records. The checks freeze consumed-round records and forbid phantom continuation-week certificates.
Global NBA stat rows and their input revisions continue to change for real imported players; these are not fantasy results for a member.

`tests/db/scoring-idempotent-finalization.sql` separately checks row preservation, real corrections and stale-token rejection.
It compares tuple locations because all writes occur in one rollback-only transaction.
It has no clock change, network provider or wall-clock correctness threshold and can join the CI database chain.

Append the five new mutations with `python3 scripts/mutation/live/eliminated-catalog.py`.
Their IDs are live-elim-01 through live-elim-05. Use the existing runner's baseline and tier1 phases with those IDs.
The first two remove the actual finalizer's unchanged-row guards; the third permits playoff standings;
the fourth reverses max-points roster eligibility; the fifth removes the certificate redelivery guard.
