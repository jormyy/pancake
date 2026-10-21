# Historical season simulator

The simulator exercises local production dispatch, Edge handlers, database rules, and authenticated user actions.
Its generated evidence establishes coverage.
Earlier reports and fixture facts do not establish a new run's result.
See the [command guide](../scripts/season-sim/README.md).

The [real two-season leg](#real-two-season-leg) runs 2024–25 followed by 2025–26.
The earlier synthetic next-season mode remains available separately.

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

The earlier retained diagnostic stops at the March 26 coverage check.
The corrected diagnostic completes March 23 through April 12 on the integrated application.
It passes the strict quarter checks and proves the automatic champion on April 13.
Its first season-end assertion then reads only one of six pending claims.
The database retains all six claims without processing or cancellation.
The corrected harness reads each pending claim through its authenticated owner.
Later outcomes require their generated continuation evidence.
Next-season morning steps preserve any worker time advanced during snapshot preparation.
Rookie expiry waits for the first cron minute strictly after the recorded pick expiry.

Measured game-date times are 259.369 seconds for October 21 and 416.999–509.463 seconds for March 23–25.
These measurements use earlier retained source copies, rather than the running fresh replay.
An idle offseason date has not run.
At 450 seconds per game date, 194 selected historical and next-season dates take about 24.25 hours.
This estimate excludes offseason cadence and setup; the complete duration remains unmeasured.


## Pending claims and season-end recovery

Pending waiver claims are private to their managers.
The policy is `supabase/migrations/20260627000018_waiver_claim_privacy.sql`, line 11.
A commissioner read cannot measure the whole pending batch.
The harness reads every scenario owner through the authenticated REST route.
It checks each expected claim ID, owner, pending status, processing time, and failure reason.
Missing claims and changed statuses fail independently.
Resolved claim checks also use the owners' reads.

Successful conditional drops create another 48-hour waiver hold.
The real rollover guard requires all pending claims and uncleared holds to settle.
The harness records that specific boundary refusal only for its declared postseason scenario and league.
Unclaimed holds expire only when `clears_at < now()` in migration `20260815000006_offseason_waiver_wire_expiry.sql`, line 24.
A hold created at 03:00 ET therefore expires on the daily run strictly after its 48-hour clear time.
The wait includes that expiry run and one daily boundary window.
An unrelated error or a missed bound still fails.
No worker or scoring override clears these holds.

The `automatic-champion` snapshot precedes the pending-claim assertion.
Its segment continues through rollover, the rookie draft, and the next-season weeks.
A stopped diagnostic can also save this checkpoint from retained data:

```sh
. ~/pancake-t_4ba51e0d/env.sh
cd "$TASK/lanes/sim/repo"
export SEASON_SIM_SNAPSHOT_ROOT="$TASK/shared/sim/snapshots-r7"
node scripts/season-sim/retained-check.mjs --save-automatic-champion --context-snapshot pre-playoffs
node scripts/season-sim/index.mjs --segment automatic-champion
```

The existing stack must contain the failed run's retained database and evidence.
The context snapshot must belong to the same league season.
The save checks the retained champion against the database and requires a paused clock with no unfinished workers.
It generates new local sessions only for existing simulator users.
It preserves application business data and records the retained failure as prior evidence.
The dump and session-bearing metadata stay private and outside the repository.
The continuation never counts as a fresh replay.
Use a new snapshot root for each attempt to preserve earlier snapshots.

`phaseTimings` records measured season-end, rollover, offseason, draft, and next-season costs.
`nextSeasonProgress` and the replay checkpoint record each next-season date as it completes.
A phase without a completed measurement remains unverified.
The separate automatic rookie backstop remains unverified until an explicit scenario proves it.


`--save-post-rollover` saves a retained rollover checkpoint through the same guarded path.
Its context remains tied to the old champion and the recorded new season.
The post-rollover segment checks the new waiver budget and order, then continues through the draft and next-season weeks.

Score certification refreshes `matchups.score_read_started_at` and `standings.created_at`.
It also publishes the current waiver priority with rebuilt standings.
The SQL writes these fields in migration `20261017000001_dynasty_rules_and_trade_plans.sql`, lines 2988 and 3074–3081.
The rollover history check records these changes separately.
A changed standings priority must match the independent waiver ledger.
Every result field, row ID, finalization time, winner, score, and standings total must remain unchanged.
Raw stored game stats still require the complete original digest.
The next-season history check retains its full digest after rollover has settled.


## Skipped weeks and daily lineups

A skipped week suppresses fantasy matchups, published standings, and score certification.
It does not remove NBA game dates or daily lineup preferences.
The pre-tipoff optimizer can still fill daily starter slots.
Its selector and writer have no skipped-week exclusion in migration `20261018000005_resume_pre_tipoff_optimizer.sql`, lines 15–39 and 126–129.
The gate follows scheduled NBA tipoffs in migration `20261019000002_pre_tipoff_scheduled_start.sql`, lines 13–31.
Lineup locks still follow the player's NBA game start.
The matchup client reads only non-voided matchup rows in `lib/scoring.ts`, lines 114–132.

The harness permits daily lineup rows and records their count.
It requires no matchup spanning the skipped week, no standings row, and no score certificate.
It compares add counts and roster transactions with the genuine manager actions in its scenario ledger.
An optimizer row cannot consume an add or create a roster transaction.
The score publication and finalization guards are migrations `20261020000031_certify_live_score_publication.sql`, line 36, and `20261018000006_queue_matchup_final_notifications.sql`, line 61.
The standings rebuild uses only finalized, non-voided matchup weeks in migration `20261017000001_dynasty_rules_and_trade_plans.sql`, lines 214–236.

Waiver limits keep their calendar buckets during skipped weeks.
Genuine successful claims consume that week's limit and reset at the next calendar week.
This follows `private.current_add_week` in migration `20260827000006_single_owners_for_pick_and_reservation_rules.sql`, line 109.
The skipped-week checks continue after weeks two and three to catch later phantom publications.
These checks do not treat global NBA player stats as fantasy matchup scores.

The first days of eligible weeks two and three check every manager's add counter and calendar week.
They compare the next reset time with Eastern midnight, including the November 1 clock change.
A resumed next-season segment also verifies the subscribed client's score changes before it completes.

The Realtime probe updates its channel when authenticated reads refresh the local session.
This keeps a long next-season segment from retaining an expired startup token.

Next-season dates also run the historical delivery-coverage check, including required regulation-quarter snapshots.
The daily record stores that coverage with its live-score and weekly checks.

Before each next-season waiver batch, genuine free-agent adds maintain enough NBA roster depth for scoring checks.
These adds obey the weekly limit and enter the independent transaction ledger.
The scenario drops NBA players and retains an NBA player for every manager.
No roster-size or add-limit setting changes to make the scenario pass.

A manager who uses the weekly add on a refill cannot submit another claim that week.
The harness checks the real API rejection and proves that no pending claim is stored.
Only accepted claims enter the processing oracle; rejected proposals remain in the scenario evidence.

## Real two-season leg

This mode supersedes the synthetic 2026–27 continuation for the new card scope.
It replays real 2024–25, its automatic champion and rollover, the real 2025 NBA draft board, then real 2025–26 through its champion.
The synthetic continuation remains an explicit legacy operation.
Real mode refuses synthetic remapping and legacy segment continuation.

Set these variables before starting Node:

```sh
export SEASON_SIM_ROOT="$TASK/lanes/sim"
export SEASON_SIM_PROJECT=pt4basim
export SEASON_SIM_PORT_PREFIX=572
export SEASON_SIM_YEAR=2025
export SEASON_SIM_MODE=two-season
export SEASON_SIM_FIXTURES="$TASK/shared/sim2/replay"
```

The root, exact loopback ports, project, container and Docker socket guards still apply.
Real-mode snapshots default to `shared/sim2`, and refuse the protected `shared/sim` folder.
Snapshot metadata hashes the selected fixture manifest and two-season plan.
The second champion has a separate snapshot name.

The source archive must contain the final integrated application and harness.
The orchestrator supplies the committed source SHA and records its archive hash in `application-source.json`.
Its `harnessSha256` must equal `harnessManifest()` on that extracted tree.
`integration.tar` must hold that exact archive.
A full launcher refuses a harness overlay.
After the existing replay ends, the orchestrator runs:

```sh
cd "$SEASON_SIM_ROOT/repo"
nohup sh -c 'node scripts/season-sim/fresh-run.mjs --source-sha "$SEASON_SIM_SOURCE_SHA"; result=$?; echo "$result" > "$SEASON_SIM_ROOT/two-season.exit"; exit "$result"' \
  > "$SEASON_SIM_ROOT/two-season.log" 2>&1 &
echo $! > "$SEASON_SIM_ROOT/two-season.pid"
```

`SEASON_SIM_SOURCE_SHA` is the final 40-character integration SHA.
The launcher creates a fresh database and disables native cron.
It drives every production cron minute, real workers, and authenticated manager actions.
It restores the native clock and stops only its configured project after success or failure.
`evidence/replay-checkpoint.json` holds progress.
`evidence/final-run.json` and `evidence/exit.json` hold the final outcome and cleanup.
The existing replay, its export and `shared/sim` must remain untouched.
This document does not authorize another process to launch the new leg.

### Input preparation

Collection writes only into the lane folder.
Publish completed inputs into the new `shared/sim2` folder after validation.
Never replace the existing `shared/sim` store.

```sh
SEASON_SIM_YEAR=2025 node scripts/season-sim/index.mjs --collect \
  --fixtures "$SEASON_SIM_ROOT/t3-inputs/2025" \
  --evidence "$SEASON_SIM_ROOT/r9-evidence/2025"
node scripts/season-sim/index.mjs --collect-two-sources
node scripts/season-sim/index.mjs --collect-rosters
node scripts/season-sim/index.mjs --prepare-two
SEASON_SIM_MODE=two-season SEASON_SIM_YEAR=2025 \
  SEASON_SIM_FIXTURES="$SEASON_SIM_ROOT/t3-inputs/replay" \
  node scripts/season-sim/plan-audit.mjs
```

The 2025–26 raw fixtures reuse the lane's pinned store and preserve its response hashes.
`prepare-two` rejects synthetic game inputs and non-final boxes.
Every fetch attempt records URL, time, status, bytes, hash and provenance.
The published `sources` folder retains failed attempts and empty archive results.
The prepared `replay/manifest.jsonl` selects the latest record per source key.
`derived-manifest.json` hashes the calendar, schedule, roster history and publication policies.

NBA Stats supplies both historical NBA-format schedules.
Their `gameId`, `weekNumber`, `postponedStatus`, `gameLabel` and `gameSubtype` remain source metadata when present.
Reconstructed original dates use a derived NBA week number instead of the later makeup week.
NBA final boxes, PBP, ESPN scoreboards, summaries, draft HTML and draft JSON are REAL-RAW.
The calendar, matched game identities, roster projection and live reconstruction are REAL-DERIVED.
Fantasy users, bids, lineup choices, trades, and source-availability timing are SYNTHETIC.
No real-mode route returns a `Synthetic Prospect` row.

Dated preseason observations supply the opening roster without exposing future NBA players.
Preseason boxes supply roster evidence only; they never enter scoring games or fantasy weeks.
A camp-only person needs a prior/current NBA career in the pinned registry.
Unknown camp registrations remain excluded and are listed in `roster-source-audit.json`.
The roster and NBA index contain one row per observed NBA person.
A stable first-observed ESPN alias carries later dated NBA team observations from all source aliases.
Historical experience uses the season offset from the NBA first-year field.
This establishes the zero/nonzero rookie fence; it is not an exact career service-year count.
Exact historical roster-cut instants remain unverified.

The startup managers spend their remaining auction budget on their last active slot.
This follows the real rule that an auction stays open while managers can still buy eligible taxi players.
It leaves taxi capacity for the later rookie draft.

The origin serves the pinned 2025 NBA news, draft page and Stats draft response through the product's normal routes.
The complete board becomes available on June 28 under an explicit conservative SYNTHETIC availability policy.
Earlier requests receive 503, with the actual failed worker and sync-run error recorded.
Only that declared source-unavailable failure may continue; unrelated failures remain fatal.
The commissioner starts the fantasy rookie draft after the production draft-board cron succeeds.
At least one five-second pick timer expires through the production expiry gate.

### Independent checks

The oracle uses the first `002` game day as opening night.
It groups the raw regular schedule into NBA weeks and derives the All-Star merge from the single long no-game gap.
Week ranges use actual first and last regular game dates.
A Cup gap cannot invent Monday games.
Later fantasy week numbers shift down one after the merged week.
Both `006` Cup finals and every exhibition are excluded; `002` Cup games count.

The first league has no skipped opening week.
The second league sets `skipped_weeks={1}` through the commissioner configuration RPC before opening.
The first eligible matchup and all later weeks retain their independent calendar ranges.
The pre-break and post-break add checks share one merged-week count and reset time.

The six required postponements retain their original date, confirmed unavailable phase, and makeup date.
Official NBA announcements supplement the two wildfire scoreboards that lack makeup notes.
Original NBA snapshot IDs and exact announcement instants remain unproven.
IDs use a unique raw team/date correlation.
When publication timing is unknown, a declared SYNTHETIC policy retains cross-week postponements through original-week closure.
The two wildfire reschedules use their official announcement dates, with a declared synthetic noon availability time.
This tests confirmed-unavailability handling; it does not reconstruct exact historical publication times.
The original week must finalize on time while that marker persists.
The makeup must retain one game row and one stat row per player in the independently derived played week.
Daily raw-point and weekly matchup checks also apply to those games.

The real draft board identifies rookies independently by NBA person ID and draft number.
Each raw rookie box appearance requires one canonical player, one stat row, and independently correct fantasy points.
A selected rookie must keep its original draft player row.
Started and benched rookie preferences must reach locked lineups.
A genuine midseason fantasy trade must produce later nonzero starter points for the new owner.
A genuine drop and waiver re-add must keep the player identity.
Missing rookie games are failed assertions, never successful or unmeasured coverage.

Anthony Davis in 2025 and James Harden in 2026 are the NBA-deadline continuity subjects.
Their old/new teams and first played appearances for their new teams come from pinned NBA boxes and official announcements.
Managers acquire them before the NBA trade.
The oracle checks the same player row, new NBA team, same fantasy owner, locked starts, and continued points.
These are representative NBA deadline trades, not an audit of every NBA transaction.

Both seasons retain live, final, weekly, bracket, champion, trade, waiver and pick checks.
The second season preserves settled first-season stats, matchups, standings and used picks.
Future traded picks retain their owners during second-season scoring.
Rankings/projection input quality and historical career totals remain explicit gaps.
No full-run timing is inferred from a partial or resumed segment.
A wall-time budget applies only when the run declares one; twelve hours is not an implicit two-season acceptance rule.

A two-date diagnostic may defer the full-calendar failure until its requested dates finish.
It still returns that failure and cannot claim acceptance.
The full launcher never enables this diagnostic option.


The real-mode launcher audits all 2,460 court sequences before it starts the database.
Raw source bodies remain unchanged.
One 2024 opening-night sequence needs a derived substitution identity correction.
The original event names an absent player.
The unique correction agrees with the other NBA minutes and ESPN's rounded minutes.
NBA's team-minute total is impossible for that game, so ESPN corroborates the conflicting player's minutes.
`court-source-audit.json` records the original identity, correction, and source-minute conflict.
Unresolved or ambiguous corrections fail the audit.
Overtime starter inference ignores at most 1.1 seconds of source rounding residue.

The final historical schedules contain later information, including Cup opponents.
Only the six declared postponement timelines reconstruct changing availability.
Earlier complete NBA schedule snapshots remain unavailable.
This is a historical replay with declared publication policies, not a raw archive of every original schedule release.


### Bounded evidence before integration

The baseline application is `454cf583`; the harness is a working overlay.
The production draft cron imports all 59 real picks in 69.809 seconds.
The board check verifies names, numbers, rookie experience and unlinked NBA identities.
Opening night and its following date verify 12 final games and 4,390 live score samples.
Their replay times are 247.656 and 386.846 seconds.
The diagnostic exits on the baseline calendar mismatch after those dates pass.
It does not bypass that mismatch for a full launch.
The baseline publishes 25 weeks; the independent oracle requires 24.
The baseline planner also returns opening dates one day late under its five-game rule.
Its stored opening week and opening-night scoring remain correct in this bounded check.

Using 386.846 seconds for ordinary dates and the earlier 509.463-second playoff sample projects about 40 hours.
The broader measured range projects 31–50 hours, including the idle offseason.
These are projections, not a completed-run duration or a promised runtime budget.
The 138 harness tests, changed-file lint, dead-code check and e2e type check pass on the mini.
The full two-season replay and its new late-season manager scenarios remain unmeasured.
The automatic unstarted-rookie backstop remains outside this scenario.
Three additional postponed rows remain explicit gaps beyond the six required examples.
See the published `shared/sim2/README.md`, input manifests and `postponements.gaps` before launch.
