# Historical season simulator

The simulator exercises local production dispatch, Edge handlers, database rules, and authenticated user actions.
Its generated evidence establishes coverage.
Earlier reports and fixture facts do not establish a new run's result.
See the [command guide](../scripts/season-sim/README.md).

## Inputs

| Class | Inputs |
| --- | --- |
| REAL-RAW | NBA final boxes and play-by-play, ESPN JSON, published 2026–27 NBA schedule |
| REAL-DERIVED | Historical schedule, roster observations, injury selection, historical live snapshots |
| SYNTHETIC | Users, actions, invented prospects, next-season boxes and live snapshots |

Manifests record source URL, retrieval time, status, byte count, and SHA-256.
Reads verify decompressed bytes.
Next-season mappings retain the historical source game and target schedule hash.
Known source exceptions remain pinned; they never exempt official final equality.

## Checks

| Area | Independent evidence |
| --- | --- |
| Live matchups | Authenticated client score read versus stored stats and locked starters; private Realtime subscription |
| Weekly scoring | Every expected result finalizes; standings rebuild from completed regular results |
| Playoffs | Independent seeds, bracket advancement, grace periods, multi-week point totals |
| Champion | Finalized final, independent winner, authenticated bracket read before rollover |
| Deadline | Commissioner setting, completed early trade, blocked late proposal and acceptance, pending offer state |
| Rookie draft | Independent prior standings order, snake reversal, traded owner, production expiry path |
| Picks | Far-year allocation, unused rounds, retained traded ownership |
| Next season | Published schedule, synthetic scoring, fresh standings, retained season-one history |

An implemented check is not a measured pass.
Reports retain missing acceptance work and distinguish assertion failures from execution failures.
The report adds continuation wording only when a continuation occurs.
It never imports old defect fixes as new evidence.

## Trigger fidelity

Production cron gates drive automatic outcomes.
Production has no daily direct `sync-stats` or `sync-scores` job.
The replay removes those morning and season-end overrides.
A missing champion or rollover must remain a failure.
A commissioner matchup-generation request is an authenticated setup action.
The installer records the actual migrated cron catalog before disabling jobs.

Internal worker sampling uses the discrete-clock path described below.
Tier 2 segment baselines are dropped. Ancillary ranking and projection quality stays an explicit coverage gap.
Published segment durations stay unknown until measured.
A short or resumed diagnostic run never counts as a fresh full replay.

## Discrete clock and internal samples

The replay pauses business time during database and HTTP work.
It advances to each cron minute and each worker timer deadline.
Network abort deadlines keep their real wall-clock budget.
Fractional retry delays round up to a whole millisecond.
The dispatcher distinguishes completed workers from delayed pg_net response collection.

The Edge wrapper probes before every internal live-work read with a live-holder header.
It also probes after each worker and gate.
These reads include every internal tick, plus scoreboard reload reads.
The origin checks a runtime token before it accepts a probe.
A failed comparison fails the production dispatch.
`boxscore-deliveries.jsonl` retains every box-score delivery, including repeated clocks.
The general upstream log remains sampled.
The summary's clock keys retain the latest delivery time, rather than the first.

The late-season diagnostic skips completed calendar weeks through the commissioner configuration RPC.
This creates a declared late-start league, with real games in its remaining weeks.
It does not invent earlier results or bypass season-boundary rules.
The full replay requires an empty application database.

## Skipped first week and waivers

The next-season fixture mapping covers October 20 through November 8, 2026.
Its 146 games use the pinned published schedule and synthetic box/PBP inputs.
Eastern game times change from UTC−4 to UTC−5 on November 1.
The commissioner skips week 1 after schedule ingestion, before matchup generation.
The replay requires no week-1 matchups, lineups, or standings.
Weeks 2 and 3 keep their calendar numbers.
Playoffs still start in configured calendar week 23.

The initial league uses FAAB 100 and one weekly add.
The waiver scenario submits real claims after real drops.
Its oracle orders bids, current priority, claim order, submission time, and claim ID.
It checks roster failures, over-budget rejection, awards, balances, priority, and add counts.
The offseason commissioner changes this retained league to rolling waivers.
This bounds runtime and keeps the same cross-season assets under test.
Rolling scenarios run during skipped week 1 and eligible week 2.
A separate batch remains pending at champion finalization.
Expected rollover deferrals remain recorded until production waiver processing resolves that batch.
These flows require measured replay evidence before acceptance.

## Restore order

Snapshot dumps contain data only.
Restore installs the clock, fingerprints application functions, restores data, then checks the fingerprint again.
Runtime startup checks that it preserves this fingerprint.
The optional SQL overlay runs last, after runtime startup.
No later restore replaces the lane's application definitions.

```sh
node scripts/season-sim/index.mjs --segment live-week \
  --after-restore-sql /absolute/path/to/mutant.sql
```

The generated restore and segment proofs record function hashes and overlay hashes.
A missing snapshot or failed baseline cannot serve as a mutation oracle.
Every replay snapshot waits for pending dispatch, active handlers, and in-flight fetches.
Preparation steps sleeping worker deadlines through the normal cadence driver.
The clock stays paused during I/O, and every intervening cron minute still runs.
Preparation fails after two real minutes or two business minutes of worker deadlines.
The writer checks for quiescence again before dumping data.
An offline retained-state dump requires a refused runtime connection and no unfinished dispatch.
Snapshot metadata records the final wait; the replay records preparation time and business-clock steps.
This applies to waiver-week, live-week, pre-deadline, pre-playoffs, pre-rollover, post-rollover, pre-draft, and next-season-start.
The pre-rollover snapshot follows the champion; post-rollover follows season advancement.
The current integrated late-season diagnostic is incomplete.
The base comparison, Tier 2 segment baselines, and pre-deadline segment proof are dropped from this card.

The replay serves the pinned next-season schedule from July 1 in this synthetic scenario.
It does not measure the schedule's historical publication date.
Next-season roster and injury responses derived from mapped games carry the SYNTHETIC label.

Maximum-score candidates come from roster ownership and availability transactions at each game's tipoff.
The oracle folds that history independently and checks player position eligibility.
A later drop cannot erase an earlier bench player's maximum-score eligibility.
Weekly lineup rows only supply actual starter scores.

A retained-state check can isolate a harness correction without rerunning application outcomes:

```sh
SEASON_SIM_SNAPSHOT_ROOT="$TASK/shared/sim/snapshots-r2" \
node scripts/season-sim/retained-check.mjs --date 2026-03-22
```

This check never counts as a fresh replay.


## Boundary timing

The cron calls the boundary gate every fifteen minutes.
The gate dispatches once per Eastern date, from 09:00 onward.
The strict missing-bracket check waits for the first daily dispatch after the 48-hour correction period.
It fails at that dispatch time if the expected rows remain absent.
The calculation follows Eastern daylight saving changes.

The retained March 25 failure occurred at 09:00 UTC, which is 05:00 EDT.
Its week-22 certificate matched the current input token.
Its stale-week RPC returned no rows.
The previous boundary workers returned no actions before the correction period ended.
This evidence classifies that stop as a harness timing defect, rather than proof of P-B4.
The next eligible dispatch is March 25 at 13:00 UTC.

## Fresh replay launch

Use the final integration commit after the diagnostic and quality checks pass.
Do not overlay files onto its extracted source.
The launcher refuses a harness hash that differs from the pinned archive.
The launcher removes only its configured local stack's old database backup.
It applies all migrations with cron disabled, then requires an empty application database.
It creates a new snapshot directory for this run.
It records the source SHA, archive hash, command, process ID, start, and end.
It restores native database clocks and stops its own stack after success or failure.
The final JSON exit file records cleanup failures too.

On the editing Mac:

```sh
SHA=<final-committed-integration-sha>
EVIDENCE=/Users/michaelchen/.hermes/kanban/workspaces/t_4ba51e0d/evidence/sim
git archive "$SHA" --output="$EVIDENCE/integration.tar" -- . ':!.env*' ':!**/.env*'
rsync -a -e /Users/michaelchen/.hermes/kanban/workspaces/t_4ba51e0d/bin/ssh-via-mbp \
  "$EVIDENCE/integration.tar" mini:pancake-t_4ba51e0d/lanes/sim/integration.tar
```

After capacity admission, run the following on the mini through the required SSH wrapper.
First ensure the diagnostic has exited and its evidence has been copied.
Keep its source copy under the same lane folder.

```sh
. ~/pancake-t_4ba51e0d/env.sh
SHA=<same-final-committed-integration-sha>
cd "$TASK/lanes/sim"
mv repo "repo-before-$SHA"
mkdir repo
tar -xf integration.tar -C repo
cp -cR "$TASK/base/node_modules" repo/node_modules
cd repo
SEASON_SIM_SOURCE_SHA="$SHA" node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises'
import { sha256 } from './scripts/season-sim/common.mjs'
import { harnessManifest } from './scripts/season-sim/source-manifest.mjs'
const source = {
  commit: process.env.SEASON_SIM_SOURCE_SHA,
  archiveSha256: sha256(await readFile('../integration.tar')),
  harnessSha256: (await harnessManifest()).sha256,
  excluded: ['.env*', '**/.env*'],
}
await writeFile('../application-source.json', JSON.stringify(source, null, 2))
JS
nohup node scripts/season-sim/fresh-run.mjs --source-sha "$SHA" \
  > ../fresh-run.log 2>&1 < /dev/null &
echo $! > ../fresh-run.pid
```

Progress: `cat "$TASK/lanes/sim/evidence/replay-progress.json"`.
Completion: `cat "$TASK/lanes/sim/evidence/exit.json"`.
Output: `tail -30 "$TASK/lanes/sim/fresh-run.log"`.
Acceptance: `cat "$TASK/lanes/sim/evidence/final-run.json"`.
The report prints one result for each of twelve acceptance areas.
An incomplete area prints `not measured`.
Missing evidence cannot produce full acceptance.

The cadence profile records wall time, clock steps, and minute counts by Eastern date.
It includes all production minute calls and worker wakeups.
Normal date results also include full day wall time and assertion costs.
A current projection still requires measured game, playoff, and offseason days.
Do not substitute an earlier card's duration.

## First-date launcher check

Snapshot save and restore resolve `SEASON_SIM_SNAPSHOT_ROOT` when called.
A launcher can set its unique run directory after module imports.
The root, project, ports, and Docker socket must still be set before Node starts.
The replay reads production-only flags when used; its Edge child starts after the clock flag is set.

A bounded launcher check exercises the first replay date and its snapshot:

```sh
. ~/pancake-t_4ba51e0d/env.sh
cd "$TASK/lanes/fresh-check/repo"
SEASON_SIM_ROOT="$TASK/lanes/fresh-check" \
SEASON_SIM_PROJECT=pt4bafreshchk SEASON_SIM_PORT_PREFIX=575 \
node scripts/season-sim/fresh-run.mjs --source-sha "$SHA" --check-first-date
```

Use the assigned scratch stack only after the other 575xx stack stops.
This mode permits a recorded harness overlay for a committed application archive.
It always reports full acceptance as false.
Success requires one complete date, live comparisons, an empty initial database, and a populated snapshot in the run directory.
It writes `first-date-check.json`, restores native clocks, stops its project, and removes only its inspected backup volume.
The real fresh replay omits this flag and still refuses a harness overlay.

Use `--check-through 2025-10-27` instead to check all seven opening dates.
This bounded mode requires both waiver-week and live-week snapshots.
It writes `launcher-check.json` and performs the same clock, stack, and inspected-volume cleanup.
It permits a recorded harness overlay and never counts as a fresh full replay.
Dates after October 27 and conflicting check flags fail before stack startup.

## Delayed-tipoff reproduction

The retained March 26 diagnostic on `21f5a3bb` misses quarter one of game `0022501063`.
The pinned play-by-play starts at 23:11:00.200 UTC and ends quarter one at 23:39:12.800 UTC.
The game is scheduled for 23:00 UTC.
The last pre-tipoff worker finishes at 23:10:20 UTC.
No live worker runs during quarter one.
The next worker starts at 23:40 UTC, when the first stored stat rows appear.

The old `get_live_poll_work` stops frequent checks ten minutes after the scheduled tipoff.
Its late-game branch waits thirty minutes after the previous check.
This leaves the entire first quarter without work for this game.
The original definition is in `supabase/migrations/20261018000003_bound_live_ingestion.sql`, lines 42–47.
Migration `20261020000033_poll_delayed_tipoffs.sql` extends frequent checks through 45 minutes after the scheduled tipoff.
The worker now follows `needs_scoreboard` through `supabase/functions/live-poll/policy.ts`.
The simulator keeps every required quarter.

Run this probe on a stopped-worker diagnostic database that already contains this scheduled game:

```sh
. ~/pancake-t_4ba51e0d/env.sh
cd "$TASK/lanes/sim/repo"
node scripts/season-sim/index.mjs --probe-delayed-tipoff
```

The command uses the configured loopback stack and pinned fixture hashes.
It reconstructs the pre-tipoff check inside a transaction, reads the real work selector, then rolls back.
Its synthetic probe state is separate from its real-derived fixture snapshots.
The report is `evidence/delayed-tipoff-probe.json`.
It exits nonzero when every first-quarter cron tick has no work.
It checks that the retained game and attempt rows remain unchanged.
The `cb74d8f7` integration returns no work at all fourteen ticks from 23:12 through 23:38 UTC.
The unchanged probe on `658dd95c` returns work at all fourteen ticks and exits zero.
The fixture and oracle hashes match across that red/green pair.

The retained diagnostic completes March 23–25 and stops at the March 26 coverage check.
It creates two semifinal rows automatically on March 25.
It does not reach a finalized semifinal, final, champion, rollover, or rookie draft.
Champion-dependent trading, offseason picks, rolling waivers, next-season limits, and skipped-week/DST flows remain unmeasured.
The corrected diagnostic resumes from `pre-playoffs` and continues through those paths.
Their measured results still require its generated evidence.
Next-season morning steps preserve any worker time advanced during snapshot preparation.
Rookie expiry waits for the first cron minute strictly after the recorded pick expiry.

Measured game-date times are 259.369 seconds for October 21 and 416.999–509.463 seconds for March 23–25.
These measurements use earlier retained source copies, rather than the running fresh replay.
An idle offseason date has not run.
At 450 seconds per game date, 194 selected historical and next-season dates take about 24.25 hours.
This estimate excludes offseason cadence and setup; the complete duration remains unmeasured.
