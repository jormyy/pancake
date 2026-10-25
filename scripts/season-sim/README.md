# Historical season simulator

This harness drives local production gates, Edge handlers, and authenticated manager actions.
Generated reports distinguish completed checks from missing coverage.
A diagnostic run cannot establish full acceptance.

The [bounded acceptance matrix](../../docs/bounded-replay-acceptance.md) records the saved replay through November 9, 2025.
It separates measured outcomes from retained stream and source limits.

## Configuration

Source the task environment on the mini before every command.
Run from the `repo` child of the configured root.
Keep fixtures, state, snapshots, and evidence outside that child.

| Environment variable | Default |
| --- | --- |
| `SEASON_SIM_ROOT` | `~/pancake-t_4ba51e0d/lanes/sim` |
| `SEASON_SIM_PROJECT` | `pt4basim` |
| `SEASON_SIM_PORT_PREFIX` | `572` |
| `SEASON_SIM_CONTAINER` | `supabase_db_<project>` |
| `SEASON_SIM_DOCKER_SOCKET` | Unix socket from `DOCKER_HOST` |
| `SEASON_SIM_CLI` | Task `tools/bin/supabase-go` |
| `SEASON_SIM_SNAPSHOT_ROOT` | Task `shared/sim/snapshots` |

Only loopback HTTP and PostgreSQL targets in the configured block pass the guards.
The production project reference always fails.
The database helper checks the configured container and its database port before its first query.
Port suffixes are API 21, database 22, origin 80, router 81, inspector 83, and fault target 89.
Assigned blocks are 572–575. Block 581 belongs only to the supplemental project and 582 only to the replacement replay.
The installer changes configuration only inside the mini copy.
It disables cron launch before applying migrations.
It saves the installed cron catalog before unscheduling jobs.
The task supplies native PostgreSQL 17 clients and the guarded Docker socket.
Local credentials come only from the configured stack's `supabase status -o env`.
Real opening recovery uses a guarded `next-season-start` snapshot and preserves completed preseason work.
Keep failed feature exports and their source receipt before revalidating the repaired opening state.

## Fixture collection

```sh
. ~/pancake-t_4ba51e0d/env.sh
cd "$TASK/lanes/sim/repo"
node scripts/season-sim/index.mjs --collect
node scripts/season-sim/index.mjs --collect-next
node scripts/season-sim/index.mjs --prepare-next
```

Collection pins public NBA CDN and ESPN responses by SHA-256.
`--collect-next` refuses a published schedule outside 2026–27.
`--prepare-next` maps historical same-team boxes and play-by-play into the first two fantasy weeks.
The published schedule is REAL-RAW.
Every mapped final box and live snapshot is SYNTHETIC.
`next-season-mapping.json` records each template, target game, time shift, and schedule hash.
No next-season box score is downloaded.
Known source limits stay pinned in `known-discrepancies.json` and `known-identities.json`.

## Replay

Preserve failed evidence before clearing the local test database.
Run fleet admission before starting a stack or replay.

```sh
node --input-type=module -e 'import { setupStack } from "./scripts/season-sim/local-stack.mjs"; await setupStack()'
node scripts/season-sim/index.mjs --replay --late-season --days 1
node scripts/season-sim/index.mjs --replay
node scripts/season-sim/report.mjs
```

The replay calls every intervening minute of the recorded business cron schedule.
It pauses business time during I/O and wakes worker timers at their business deadlines.
Internal live-work reads and worker completion trigger authenticated score probes.
The morning and season-end paths contain no direct score or stat sync calls.
An authenticated commissioner can request matchup generation during league setup.
Direct stat or score dispatch fails while the production-only guard is active.
Standalone legacy fault diagnostics remain outside acceptance coverage.

The score read follows `lib/scoring.ts`: authenticated REST reads from `matchups`.
The private Realtime probe follows `hooks/use-matchup-data.ts` and watches matchup updates by season.
The independent score oracle uses stored player stat rows and locked starters.
Weekly checks require every expected matchup and member standing.
Playoff ties use higher maximum possible points, then home.
Rookie order uses the latest prior standings: rows present first, wins ascending, points ascending, then member ID.
Snake order uses the actual member count and traded pick owners.

## Segments

Snapshots contain a data dump, paused clock, driver cursor, fixture manifest hash, and local synthetic sessions.
Treat snapshots as private local test artifacts.
The restore path checks both dump and fixture hashes.
It writes only to the configured local stack.

```sh
SEASON_SIM_ROOT="$TASK/lanes/live" \
SEASON_SIM_PROJECT=pt4balive SEASON_SIM_PORT_PREFIX=573 \
node scripts/season-sim/index.mjs --segment live-week \
  --after-restore-sql /absolute/path/to/mutant.sql
```

| Segment | Intended coverage | Measured duration |
| --- | --- | --- |
| `live-week` | Live scores, client subscription, finals | Not measured |
| `pre-deadline` | Pending offer, blocked proposal and acceptance | Not measured |
| `pre-playoffs` | Automatic seeding and bracket creation | Not measured |
| `pre-rollover` | Champion, grace, rollover | Not measured |
| `pre-draft` | Rookie order, traded owner, expiry | Not measured |
| `next-season-start` | Skipped week 1, eligible weeks 2–3, DST, retained history | Not measured |
| `waiver-week` | FAAB claims, roster failure, priority, budgets and add counts | Not measured |

The CLI exists. Tier 2 segment baselines are no longer required for this card.
Postseason cursor routing and next-season segment boundaries still require integration verification.
Do not treat an unmeasured segment as a working mutation oracle.

## Validation and limits

```sh
node --test scripts/season-sim/*.test.mjs
npm run typecheck:e2e
```

The generated report records acceptance gaps explicitly.
A fresh committed-source replay and all measured acceptance areas remain required.
Ranking and projection inputs are outside the collected historical fixture set.
Their failed dispatches stay recorded as ancillary input gaps. The report does not claim their output quality.
The driver probes every internal live-work read, worker completion, and live gate.
The current diagnostic measures this path; complete season-end evidence remains pending.
A full report checks the twelve-hour budget against measured execution time.
Do not infer it from earlier cards.

## Cleanup

Restore native clocks before stopping only the configured project.

```sh
node --input-type=module -e 'import {readFile} from "node:fs/promises"; import {sql} from "./scripts/season-sim/local-stack.mjs"; const s=await readFile("scripts/season-sim/restore-clock.sql","utf8"); await sql(s.slice(s.indexOf("BEGIN;")))'
supabase-go stop --project-id "${SEASON_SIM_PROJECT:-pt4basim}"
```

## Mutation overlay order

The CLI restores data, starts the runtime, and then applies `--after-restore-sql`.
It compares application function fingerprints before and after the data restore and runtime startup.
The overlay hash and resulting function fingerprint appear in the segment proof.
The data dump never supplies application DDL.
A baseline must pass before a mutation verdict counts.

## Source evidence

Build application code from the supplied integration archive.
Exclude `.env*`, `.git`, `node_modules`, `dist`, and `.expo` during source copies.
Place its commit, archive SHA-256, and archive harness hash in the lane's `application-source.json`.
Each new driver records the current harness file hashes before business actions.
A working overlay is not a committed-source full replay.

The maximum-score oracle rebuilds roster eligibility from acquisition, drop, IR and taxi transactions at game tipoff.
It includes past bench players even when a later drop removes their lineup rows.
`retained-check.mjs --date YYYY-MM-DD` checks retained finals, scores, standings and delivery coverage.
It does not dispatch maintenance or change application outcomes.

## Taxi acquisitions and legality

Every league uses the rookie-or-fewer-than-65-career-games rule.
The simulator never changes that rule through league settings.
Week two adds an eligible veteran straight into taxi while the active roster stays full.
A genuine drop then creates a taxi claim for another full team.
The production waiver worker must place that claim into taxi.
The scenario drops the awarded player after verification to preserve later scoring inputs.
Both acquisitions update the independent weekly add and priority expectations.

At each day's end, the simulator checks current experience and career games for every taxi player.
An ineligible taxi player requires an authenticated acquisition refusal for that owner.
The refusal must name the illegal players and use the matching roster error code.
IR and active roster problems can take precedence when those problems also exist.
