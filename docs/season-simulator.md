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
