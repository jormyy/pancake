# Historical season simulator

This harness drives local production gates, Edge handlers, and authenticated manager actions.
Generated reports distinguish completed checks from missing coverage.
A diagnostic run cannot establish full acceptance.

The [simulator contract](../../docs/season-simulator.md) defines source classes, replay modes, and acceptance.
The [bounded acceptance guide](../../docs/bounded-replay-acceptance.md) limits claims from resumed runs.

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
Assigned blocks are 572–575.
Block 581 belongs to the supplemental project, and 582 belongs to the replacement replay.
Block 587 belongs to the guarded private repair project.
Each special block requires its matching root and project from `common.mjs`.
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

The replay derives cron expectations from the ordered migrations.
It calls every scheduled business wake, including the half-minute hint drain and hourly cron-history cleanup.
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
Rookie drafts default to linear order from prior standings.
Worse records pick first; ties use higher points per game, then the stored seed.
Saved snake drafts retain their chosen order.
Traded picks keep their original slot and current owner.

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

Run each selected segment without a mutation before using it as an oracle.
An unmeasured segment cannot establish mutation coverage.

## Validation and limits

```sh
node --test scripts/season-sim/*.test.mjs
npm run typecheck:e2e
```

The generated report records acceptance gaps explicitly.
Full acceptance requires a fresh committed-source replay with all required areas measured.
Ranking and projection inputs are outside the collected historical fixture set.
Their failed dispatches stay recorded as ancillary input gaps. The report does not claim their output quality.
The driver probes every internal live-work read, worker completion, and live gate.
The report checks its time budget against measured execution time.
Earlier reports do not prove the current source passes.

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
A non-rookie needs a known career count to enter taxi.
An unknown count never makes an existing taxi player illegal.
The refusal must name the illegal players and use the matching roster error code.
IR and active roster problems can take precedence when those problems also exist.

## Official historical profile

Set `SEASON_SIM_PROFILE` to an absolute JSON file produced by `officialProfile`.
Keep the file outside the checkout. Pin the two configuration snapshot hashes and an explicit action seed.
Set `SEASON_SIM_YEAR=2025` and `SEASON_SIM_MODE=two-season`.
The usual fresh launcher then selects the official driver. Without the profile, existing modes stay available.

The profile creates ten managers and two hundred authenticated auction awards.
It preserves twenty regular roster places, two IR places, three taxi places, and the saved scoring rules.
Missing double-double and triple-double rules normalize to zero, overriding new-league defaults.
Historical broad positions do not imply finer eligibility. The auction records missing preferred starters.

The driver derives periods from the retained schedule under the current calendar rule.
It saves the pre-playoff checkpoint on February 10, 2025, and continues through November 3, 2025.
Daily eligibility snapshots precede tipoff. Historical maximum checks use those retained snapshots.
Installed cron entries and Edge entry points supply the production dispatch catalog, including subminute jobs.

`official-replay.json` contains detailed receipts. `official-summary.json` and `final-run.json` distinguish bounded completion from full acceptance.
Missing gates prevent full acceptance. Browser, load, and app-update checks require separate receipts.
Forecast weeks 10, 13, and 16 form the calibration holdout. Week 17 and playoffs form the final holdout.
Forecast receipts retain source inputs, independent prior-game scoring, actual outcomes, and constant/prior-mean baselines.
Missing probabilities count as cold coverage, never as successful predictions.

Start the official replay late without a saved checkpoint:

```sh
node scripts/season-sim/fresh-run.mjs --source-sha "$SEASON_SIM_SOURCE_SHA" --start 2025-02-10
```

Keep the official profile and two-season environment settings above.
The start date can fall within a week.
It must fall between October 22, 2024, and April 13, 2025, inclusive.
Do not combine `--start` with either bounded launcher check flag.
The replay keeps profile skips and skips every week that ends before the start.
It runs through November 3, 2025, including playoffs, rollover, the rookie draft, and the next opening week.
It omits the pre-playoff snapshot when the start falls on or after February 10.
Earlier windows read `not measured: late start` in the summary.
Every remaining check must pass, including scoring, waivers, deadline trades, final forecasts, and Realtime delivery.
Final forecasts cover week 17 and the playoff rounds across weeks 18–21.
`lateStart.passed` records this acceptance; `fullAcceptance` stays false.
The launcher writes `evidence/late-season-check.json` after acceptance.
Acceptance requires completed dates, zero invariant failures, no runtime or cleanup failures, and no remaining measurable gaps.
Earlier windows stay unmeasured, and browser, load, and app-update evidence remain separate.

Check the late-start rules without starting the replay:

```sh
node --test scripts/season-sim/launcher-check.test.mjs scripts/season-sim/official-replay.test.mjs scripts/season-sim/official-report.test.mjs
```

These checks cover date bounds, midweek starts, skipped windows, remaining forecast rounds, and rejection of missing acceptance evidence.

`state/official-cursor.json` retains private manager sessions and completed evidence for recovery.
A snapshot restore must preserve its profile hash, fixture hashes, and database state.
After an infrastructure interruption, resume at the saved current clock without rewinding retained database results.
Keep interrupted-run receipts distinct from uninterrupted fresh-run evidence.
### Official replay clock compression

The official driver uses PBP-derived live checkpoints and the installed cron catalog. It keeps pre-tipoff, first-live, period, final, and unchanged-final retry checkpoints. Every worker retains its real internal timer boundaries. Other live polling intervals are omitted explicitly; the corpus does not contain archived 30-second provider responses.

Empty hint, draft, and statistics queues can skip their idle gates. The driver reads those queues after each executed boundary. It retains notification time boundaries, pending transaction work, and pre-tipoff optimizer windows. Changed inspected SQL sources stop the compressed run. Unknown cron commands keep their installed cadence. Forecast expiry and daily statistics correction jobs keep their real cadence.

The report stores the selected source hashes, game checkpoints, queue proof count, executed job counts, and omitted gate counts. Set `SEASON_SIM_STRICT_TICKS=1` to retain every installed cron tick. A short compressed diagnostic does not certify the full date range, transaction lifecycle, or performance budget.
