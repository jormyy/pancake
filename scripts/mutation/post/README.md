# Postseason mutations

Use an assigned isolated Mac mini checkout and its task environment.
All generated evidence stays outside the repository.
Fixtures are synthetic unless their recipe declares pinned historical inputs.

## Setup

The guard in `lane.mjs` defines the admitted checkout roots.
The stack uses project `pt4bapost`, API port 57421, and database port 57422.
It needs the existing Docker CLI and a checkout-local empty `docker-config` directory.
Exclude `.env*`, `.git`, `node_modules`, `dist`, and `.expo` from source transfers.

```sh
node scripts/mutation/post/setup.mjs
```

Setup disables cron before applying migrations and serves the real Edge functions.
It checks unauthenticated request rejection before reporting readiness.
Only the assigned stack's CLI status supplies local keys.
The setup does not authorize access to another stack.

## Mutation run

```sh
python3 scripts/mutation/post/build-catalog.py
node scripts/mutation/post/run.mjs --baseline
node scripts/mutation/post/run.mjs
node scripts/mutation/post/run.mjs picks
node scripts/mutation/post/run.mjs rookie-draft-11
```

Set `POST_EVIDENCE` to a new external directory under the admitted root for each run.
Run all selected oracles unmutated before applying changes.
SQL mutations replace deployed definitions; TypeScript mutations change the imported boundary module in the isolated copy.
Each TypeScript oracle starts a new Deno process.
The runner restores each definition and file and checks its SHA-256.
A restore failure stops the batch.
Migration files remain unchanged.

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
It prints commands, exits, and durations without printing keys.
`registrations.json` records the registered database order and evidence-only recipes.
The package scripts define the current CI chain.
Run focused recipes while iterating; leave the full chain to integration verification.

## Reports

```sh
node scripts/mutation/post/report.mjs /absolute/path/to/evidence
```

Pass later JSONL files after the evidence path to include later verdicts.
The report verifies catalog coverage, row schemas, source locations, and restoration evidence.
It writes `results.jsonl`, `scores.md`, and `survivors.md` outside the repository.
Compile failures do not count as mutation kills.
The [simulator](../../../docs/season-simulator.md) owns full-season and restored-segment checks.

## Regression areas

| Area | Contract |
| --- | --- |
| Rookie startup | Opening-night backstop, paused drafts, and active-roster resolution |
| Skipped first week | Authenticated settings, stable playoff start, next-season reset, and retained champion |
| Stale boundary | Refresh due leagues from persisted stats, retry once, and retain correction grace |
| Picks | Ownership, used and retired assets, traded picks, and reset rules |
| Calendar | Complete source declaration, opening date, merged All-Star weeks, and Cup exclusions |
| Unavailable games | Retained unknown-date markers, explicit resumption, and partial snapshot protection |

Trading stays open in offseason, drafting, active, and playoffs.
Setup and the startup auction close trading.
New offers and acceptance still require a legal roster and an open deadline.
Unused or retired picks cannot enter offers.
The [roster contract](../../../docs/roster-lifecycle.md) defines current taxi and acquisition rules.

A stale boundary refresh uses persisted stats and retries the guarded transition once.
Failed or incomplete refreshes remain errors.
Changed results still wait for the correction grace period.
Current certificates and repeated daily runs must not cause extra scoring.

Calendar checks require complete snapshots before inferring missing games.
A new calendar can merge a qualifying All-Star gap.
Existing calendars retain saved numbering unless a reviewed migration changes it.
Partial snapshots do not cancel unseen games or rewrite finalized history.

The [verification guide](../../../docs/verification.md) supplies ordinary database setup.
The local guard variables are `PANCAKE_TEST_API_PORT` and `PANCAKE_TEST_DB_PORT`.
The wrapper supplies this directory's assigned values.

## Served Edge paths

`edge.mjs` starts the real server and stops only its recorded process.
