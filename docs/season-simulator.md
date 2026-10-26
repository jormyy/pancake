# Historical season simulator

The simulator exercises local production dispatch, Edge handlers, database rules, and authenticated manager actions.
Generated reports establish coverage for their recorded source and inputs.
Use the [command guide](../scripts/season-sim/README.md) for the isolated stack and entry points.

## Inputs

| Class | Inputs |
| --- | --- |
| REAL-RAW | Downloaded NBA boxes, play-by-play, ESPN responses, and published schedules |
| REAL-DERIVED | Historical calendars, roster observations, injury selection, and live snapshots |
| SYNTHETIC | Managers, league actions, invented prospects, and mapped next-season games |

Manifests record source URL, retrieval time, status, byte count, and SHA-256.
Readers verify decompressed bytes before use.
Known exceptions remain pinned and cannot waive final-score equality.
Mapped games retain their source game and target schedule hash.
A historical final schedule contains later information, including postponed games and Cup opponents.
Declared publication policies do not recreate every original schedule release.

## Checks

| Area | Required evidence |
| --- | --- |
| Live scoring | Authenticated score reads match stored stats and locked starters; Realtime delivers changes |
| Weekly results | Expected matchups finalize; independent standings match completed results |
| Playoffs | Seeds, byes, round spans, advancement, and correction windows match independent calculations |
| Champion | Final result, independent winner, and authenticated bracket agree before rollover |
| Trades | Deadline rejections, ownership changes, roster plans, and completed transactions agree |
| Rookie draft | Prior standings, snake order, traded pick ownership, expiry, and consumption agree |
| Rollover | Rosters, balances, calendars, and retained history match the transition rules |
| Player reads | Paged search, displayed season, averages, and fantasy-point order match stored played games |

An implemented check is not a measured pass.
Reports retain missing coverage and distinguish assertion failures from execution failures.
Rankings, projections, push delivery, and device behavior need their own evidence.
Use [bounded acceptance](bounded-replay-acceptance.md) for resumed or truncated runs.

## Trigger fidelity

Production cron gates drive automatic outcomes.
The replay has no daily direct stat or score override.
A missing champion or rollover remains a failure.
An authenticated commissioner can generate matchups during setup.
The installer records the migrated cron catalog before disabling native jobs.
The driver then runs the scheduled business minutes itself.

Business time pauses during I/O.
The discrete clock wakes worker timers at their business deadlines and preserves intervening cron minutes.
Internal live-work reads and worker completion trigger authenticated score samples.
Snapshots wait for dispatch, handlers, and in-flight fetches to drain.
A bounded live-window check lets its current worker finish before calling `drain`.
`drain` waits at the supplied time; it does not advance time.

## Real two-season leg

Set the replay mode before starting Node:

```sh
export SEASON_SIM_YEAR=2025
export SEASON_SIM_MODE=two-season
export SEASON_SIM_FIXTURES="$SEASON_SIM_ROOT/fixtures"
```

This mode runs 2024–25 and 2025–26 through their champions.
It uses the real NBA draft board between seasons.
It refuses synthetic next-season remapping and legacy segment continuation.
Its snapshots and inputs must remain separate from any existing replay.

Prepare source inputs under the configured root:

```sh
node scripts/season-sim/index.mjs --collect
node scripts/season-sim/index.mjs --collect-two-sources
node scripts/season-sim/index.mjs --collect-rosters
node scripts/season-sim/index.mjs --prepare-two
node scripts/season-sim/plan-audit.mjs
```

The input audit rejects non-final boxes and undeclared synthetic games.
It preserves failed fetch attempts and source exceptions.
Ambiguous identity or substitution corrections fail validation.
The older `--collect-next` and `--prepare-next` flow creates a synthetic continuation separately.
That continuation does not establish real second-season scoring coverage.

## Fresh replay launch

Use a committed integration archive with matching application and harness hashes.
Keep `integration.tar` and `application-source.json` under `SEASON_SIM_ROOT`, outside its `repo` child.
The source record contains `commit`, `archiveSha256`, and `harnessSha256`.
Build it from the actual archive and `harnessManifest()` in `source-manifest.mjs`.
The full launcher rejects a harness overlay or mismatched archive.

```sh
node scripts/season-sim/fresh-run.mjs --source-sha "$SEASON_SIM_SOURCE_SHA"
```

Run from the configured root's `repo` child.
The source SHA must contain the full committed identifier.
The launcher replaces only its configured local database and creates a new snapshot directory.
It restores native clocks and stops that stack after success or failure.
Cleanup failures remain failures in `evidence/exit.json`.

Read `evidence/replay-checkpoint.json` for progress and `evidence/final-run.json` for acceptance.
Read `evidence/exit.json` for completion and cleanup.
Each acceptance area needs measured evidence.
A short launcher check cannot produce full acceptance.
Use `fresh-run.mjs --check-first-date` for an initial diagnostic.

With the official profile, start late without a checkpoint:

```sh
node scripts/season-sim/fresh-run.mjs --source-sha "$SEASON_SIM_SOURCE_SHA" --start 2025-02-10
```

Set `SEASON_SIM_YEAR=2025`, `SEASON_SIM_MODE=two-season`, and `SEASON_SIM_PROFILE` before launch.
The replay skips completed earlier weeks and runs through November 3, 2025.
The start date can fall within a week.
Use a real date within the first historical season, from October 22, 2024, through April 13, 2025.
Do not combine `--start` with `--check-first-date` or `--check-through`.
Earlier scenario windows read `not measured: late start`.
Remaining scoring, waivers, deadline trades, final forecasts, playoffs, rollover, rookie draft, opening week, and Realtime delivery must pass.
The summary records `lateStart.start`, `lateStart.passed`, `lateStart.notMeasured`, and `lateStart.gaps`.
`fullAcceptance` stays false because earlier windows remain unmeasured.
The launcher records acceptance in `evidence/late-season-check.json`.
Acceptance requires `complete: true`, `invariantFailures: 0`, `lateStart.passed: true`, and an empty `lateStart.gaps`.
Runtime, source, assertion, and cleanup failures remain failures.
The launcher exits unsuccessfully if remaining measured areas fail.
The saved late-season receipt does not establish browser, load, app-update, or earlier-window coverage.

Check the launch and acceptance rules without starting a stack:

```sh
node --test scripts/season-sim/launcher-check.test.mjs scripts/season-sim/official-replay.test.mjs scripts/season-sim/official-report.test.mjs
```

These checks reject invalid starts and missing acceptance areas, and retain explicit labels for skipped windows.

## Recovery from a real-season checkpoint

Keep the original failed run, volumes, receipts, and source inputs unchanged.
Restore a private snapshot copy at its recorded schema, then apply candidate migrations.
The recovery path checks snapshot hashes and settled history before replay.
Completed draft and opening checkpoints preserve their stored transition state.
They cannot repeat player setup or draft actions.

```sh
node scripts/season-sim/recovery-run.mjs \
  --snapshot "$SEASON_SIM_ROOT/source-snapshots/pre-playoffs" \
  --receipt "$SEASON_SIM_ROOT/source-receipt.json" \
  --days 1 --refresh-players
```

The optional refresh uses the product importer before playback and compares settled history before and after.
Omit that flag for a completed draft checkpoint.
After validating one date, use `--through YYYY-MM-DD` for a bounded continuation.
The report remains a recovered segment, never a fresh full replay.

The clock installer maps supported `CURRENT_DATE` defaults to the simulated transaction date.
Restoration returns those defaults exactly.
Unsupported clock keywords stop installation.
`npm run test:db:simulator-clock-date-defaults` covers that boundary.

## Taxi acquisitions and legal rosters

The simulator uses the same rookie-or-fewer-than-65-career-games rule as production.
It never changes that rule through league settings.
Taxi entry also checks slots, tenure, and prior exits from that team's taxi.
A non-rookie needs a known career count to enter; an unknown count cannot invalidate an existing taxi player.
Straight-to-taxi adds and awards use the actual acquisition and waiver paths.
The independent ledger checks add counts, priority, ownership, and taxi placement.
At each day's end, taxi checks require an authenticated acquisition refusal for an illegal roster.
The refusal must name the players and use the matching roster error code.
IR or active-capacity problems can take precedence when they also exist.
[Roster lifecycle](roster-lifecycle.md) owns the full product contract.

## Feature probes and limits

Rookie probes use the production timer range and pause/resume actions.
Expired picks run through the minute gate; manager selections use the API.
They do not write pick deadlines directly.
The bounded probe commands rebuild only the configured disposable stack:

```sh
node scripts/season-sim/index.mjs --probe-rookie-draft --draft-probe-phase turns
node scripts/season-sim/index.mjs --probe-rookie-draft --draft-probe-phase cutoff
```

`--extract-features <input-json>` checks saved feature observations without replaying dates.
Feature oracles include corrupted-row controls.
A failed feature sample prevents full acceptance.
The legacy Expo recorder does not prove current web push delivery.
Outbox rows, provider acceptance, and device display are separate outcomes.
Report omitted jobs and absent source inputs explicitly.

The supplemental mode uses its own guarded project, root, and port block.
Its prepared scenarios can fill specific coverage gaps without changing an existing replay.
They do not replace an uninterrupted run.
`--progress <evidence-directory> --progress-output <output-directory>` reads saved evidence without querying the running stack.
Progress estimates derive from measured dates and are not deadlines.

## Dispatch and stream diagnostics

The driver checks the real HTTP queue before advancing past an unstarted worker.
It permits queued requests while all started workers sleep and no fetch is active.
HTTP failures, timeouts, and failed worker outcomes remain fatal.

A native watchdog records bounded diagnostics when a dispatch stalls.
It records worker waits, locks, database activity, queue state, and host load without SQL text or credentials.
Probe failures do not change worker outcomes or advance business time.
Generated `stall-probes.jsonl` records its collection limits.

REST session renewal forwards the token to the private Realtime channel immediately.
The probe removes its renewal listener during cleanup and requires a live subscription at final verification.
If terminal delivery fails, retain that failure and reconcile stored state without replaying settled dates.
An independent later subscription proves only its own recorded window.
