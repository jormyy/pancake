# Postseason mutations

Use the assigned Mac mini checkout and source the task environment first.
All generated evidence stays outside the repository.
All input fixtures are SYNTHETIC.

## Setup

Copy the base checkout into the assigned lane folder.
Exclude `.git`, `node_modules`, `dist`, `.expo`, and `.env*` when syncing source changes.
Keep the base dependency copy.
The setup requires the existing Docker CLI in the lane's `bin` folder.
Use an empty lane-local `docker-config` directory.

```sh
node scripts/mutation/post/setup.mjs
```

Setup uses project `pt4bapost`, API port `57421`, and database port `57422`.
It disables cron before applying migrations.
It serves the real Edge functions through the repository's Supabase CLI workflow.
It waits for unauthenticated requests to fail before it reports readiness.

The initial measured baseline uses unmodified base migrations.
The final catalog targets the two additive fixes as well.
Existing migration files remain unchanged.

## Mutation run

```sh
python3 scripts/mutation/post/build-catalog.py
node scripts/mutation/post/run.mjs --baseline
node scripts/mutation/post/run.mjs
node scripts/mutation/post/run.mjs picks
node scripts/mutation/post/run.mjs rookie-draft-11
```

Use a fresh `POST_EVIDENCE` folder for each later run.
It must stay under the assigned lane folder.
The runner obtains generated local keys from `supabase status -o env`.
It refuses any other checkout or network target.

SQL mutations replace the deployed function body, then restore its full definition.
TypeScript mutations edit only the actual imported `seasonBoundary.ts` in the mini copy.
Their oracle starts a fresh Deno process, so no cached module survives a change.
Each restore must match the original SHA-256.
A failed restore stops the batch.
Every catalog entry records one semantic change and its exact oracle commands.

## Direct checks

```sh
node scripts/mutation/post/check.mjs tests/db/rookie-drafting-gate.sql
node scripts/mutation/post/check.mjs tests/db/rollover-year-gap.sql
node scripts/mutation/post/check.mjs tests/db/picks-lifecycle.sql
node scripts/mutation/post/check.mjs tests/db/deadline-locks.sql
node scripts/mutation/post/check.mjs tests/db/playoff-ranking-priority.sql
node scripts/mutation/post/check.mjs supabase/tests/db/rookie-backstop.ts
```

The checker accepts only repository test paths and the assigned local stack.
It prints the command, exit code, and elapsed time without printing keys.

## Reports

```sh
node scripts/mutation/post/report.mjs /absolute/path/to/evidence
```

Pass later JSONL files after the evidence path to merge updated verdicts.
The report keeps the current verdicts and applies only the later result files you pass.
It verifies catalog coverage, row schemas, source locations, and restore evidence.
It writes `results.jsonl`, `scores.md`, and `survivors.md` outside the repository.

The simulation lane owns Tier 2.
Use its published segment instructions when available.
This directory does not contain a second simulator.

## Review proof

```sh
node scripts/mutation/post/verify-review.mjs
node scripts/mutation/post/check.mjs tests/db/picks-unused-rounds.sql
```

The proof first applies the three canonical statements to the assigned database.
It checks source parity and the affected unmutated recipes.
It then loads the pristine base boundary module and the two pre-fix recovery functions.
The final rookie fixture must fail on that application.
Auction startup and commissioner pause guards must still pass on base.
The drafting-only cron gate must fail on base.
The helper restores every application file and definition by SHA-256, then proves green.
The fixture SHA-256 stays identical across red and green.

The unused-round recipe records current behavior through real offer, acceptance, and settlement RPCs.
Its assertions describe an unresolved expiry policy.
Keep it as an audit recipe until that policy is decided.

## Skipped opening week

```sh
node scripts/mutation/post/check.mjs supabase/tests/db/rookie-skipped-week.ts
node scripts/mutation/post/verify-skipped-week.mjs
POST_EVIDENCE="$TASK/lanes/post/evidence/review3/mutations" node scripts/mutation/post/run.mjs skipped-week
```

The fixture uses SYNTHETIC managers, rookies, scores, and a 2026–27 shaped calendar.
Week one spans October 20–25. Week two starts October 26.
It changes skipped weeks through the commissioner settings RPC as the authenticated role.
It checks skipped weeks before generation and after week-one results exist.
Four teams play each pair twice over the six remaining regular weeks.
The saved playoff start stays at week eight, with two-week rounds.
Automatic transitions use real score input certificates and the 48-hour grace.
The next season starts with no skipped weeks and preserves the previous champion.

The proof needs the pre-fix boundary source at `evidence/review3/seasonBoundary-before.ts` outside the repository.
Capture it from the review-start commit before testing.
The helper runs the final fixture against that source and the fixed source.
It verifies both the restored application hash and the unchanged fixture hash.
The `post-sw-NN` catalog entries use classic mutation operators.

## Stale boundary recovery

```sh
node scripts/mutation/post/check.mjs supabase/tests/db/playoff-stale-boundary.ts
node scripts/mutation/post/verify-stale-boundary.mjs
POST_EVIDENCE="$TASK/lanes/post/evidence/review4/mutations" node scripts/mutation/post/run.mjs post-stale-01 post-stale-02 post-stale-03 post-stale-04 post-stale-05
```

The new fixture uses SYNTHETIC persisted games, player stats, lineups, and rosters.
The real scorer creates current certificates before one real free-agent add makes them stale.
Two daily boundary runs expose the stall without a score refresh between them.
The fixed runner re-scores only due leagues with stale prerequisite certificates.
It uses `syncScores(leagueId, referenceDate, { recoverStats: false })` and retries the guarded SQL transition once.
A failed or incomplete refresh becomes a report error.
Changed results still wait for their new 48-hour grace.
Current certificates and a repeated daily run cause no extra score calls.
The test counts actual scorer planning requests and rejects every non-local fetch.
It covers rollover, bracket creation, round advancement, incomplete persisted stats, and an injected score-read failure.

The proof needs the review-start module at `evidence/review4/seasonBoundary-before.ts` outside the repository.
It proves both stalls on the final fixture, restores the module by hash, and proves green.
It also proves the skipped-week fixture without manual certificate replay fails before recovery and passes after it.
The skipped-week fixture now supplies persisted stats for its synthetic results.

## CI registration

The three guarded postseason scripts default to API 54321 and DB 54322.
Alternate local stacks set `PANCAKE_TEST_API_PORT` and `PANCAKE_TEST_DB_PORT`.
The mutation runner and direct checker always pass this lane's 57421/57422 overrides.
The drafting gate reads `SUPABASE_URL` through psql and sets the transaction-local `app.supabase_url`.
`public.invoke_edge_function` reads that setting when the gate queues its request.
The recipe validates the expected loopback API and DB URLs before it inserts fixtures.

`registrations.json` records the live, waiv, and post recipe order.
Six post recipes enter the fast database chain.
The skipped-week and stale-boundary scenarios stay evidence recipes because they compare real-clock grace timestamps.
The unused-round policy probe stays unregistered.

```sh
node scripts/mutation/post/setup.mjs --reset
node scripts/mutation/post/integration.mjs
node scripts/mutation/post/check-registrations.mjs package.json /absolute/path/to/package-before.json
```

Run these commands only on the admitted lane stack after sourcing the task environment.
The setup reset rebuilds only the guarded lane database from this tree's migrations.
The integration runner supplies the CI variable names and local generated keys.
It runs new live SQL entries, waiver chain entries, and all eight post recipes separately.
It skips the live TypeScript recipe pending that lane's concurrent port change.
It also proves default-port refusal before fixture changes and rejects broken registration controls.
The complete `test:db` chain remains an integration check for the orchestrator.

## Residue checks

```sh
node scripts/mutation/post/residue.mjs
```

Run this check on the admitted lane stack without a reset.
Save the review-start gate and deadline recipes under `evidence/review6/` as `rookie-drafting-gate-before.sql` and `deadline-locks-before.sql` first.
The check runs the three-season recipe, then commits SYNTHETIC residue in five league states and one expired offer.
Both old recipes must reject that residue.
All fourteen new chain entries then run twice in their registered order.
The residue must remain identical after both passes.
The final gate must also reject the pre-fix application function from the pristine base copy.
The check restores the function by SHA-256 and proves the fixed gate passes.
It runs the touched mutation tools in baseline mode and removes only its own committed fixtures.

The gate recipe temporarily archives other league states inside its rolled-back transaction.
This isolates the drafting-only fleet without changing committed leagues.
Its dispatch counts include only rows from its own transaction.
The deadline recipe drains expiry batches until its own offer appears and checks only that offer's result.
