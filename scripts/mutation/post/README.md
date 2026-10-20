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

The report combines the initial run, final run, and final rookie recheck.
It verifies catalog coverage, row schemas, source locations, and restore evidence.
It writes `results.jsonl`, `scores.md`, and `survivors.md` outside the repository.

The simulation lane owns Tier 2.
Use its published segment instructions when available.
This directory does not contain a second simulator.
