# Performance lab

The lab uses only `pt4bafablelab` and ports `572xx` on the mini.
It restores the local production-shaped backup and applies committed migrations.
It never contacts production Supabase, Vercel, or GitHub Actions.

## Baseline closure

The baseline closes after the replay passes or its exact failing gate and cause are recorded.
Every current screen adapter must work. The final table must include cold, warm and offline measurements.
The 17,112-case matrix remains the climb lanes' regression suite. Its complete execution is not a baseline closure requirement.
Historical adapter counts are not current acceptance evidence.
Run the current inventory and preserve its reports outside the repository.

Run the bounded screen-adapter and Analyzer check after replay cleanup:

```sh
npm run test:perf-lab:closure
```

It checks the current screens, sections, and Analyzer cases.
It writes `lab/closure-verification.json`, the per-case captures and the screenshot gallery.
The stack stops before the command returns.

## Run from the Mac

Use Node 22 and the existing `node_modules` link.
Commit changes before running the lab.
The launcher sends a Git bundle to the private mini checkout.
Docker, builds, browsers, and replay run on the mini.

Run the complete candidate measurement with this command:

```sh
env -u PERF_LAB_CASES -u PERF_LAB_SURFACE -u PERF_LAB_SECONDS \
  PERF_LAB_CAPTURE_PROFILE=full PERF_LAB_SCOPE=all \
  PERF_LAB_ROLES=commissioner,member PERF_LAB_DAYS=in-progress,final \
  PERF_LAB_STATES=cold,warm,offline,server-change,empty,error \
  PERF_LAB_STOP_ON_FAILURE=0 npm run perf:lab -- all
```

This includes every declared screen, section, sheet, and interaction step.
It measures cold opens, warm reopens, and offline reopens for both roles and day states.
It also exercises server changes, empty content, and refresh failures.
Cold cases use a new browser context. Warm and offline cases first populate that context's caches.
Offline cases then disable its network. Each case records its own screenshots and HAR.
No case count or time limit applies to this command.

`all` restores separate databases for the screen walk and replay.
Screen fixtures cannot change replay inputs.
Release builds set `PANCAKE_PREVIOUS_RELEASE_ROOT` to a local export.
A failed acceptance check returns exit code 1 and retains evidence.
Current unproved matrix rows still prevent a successful acceptance result.
That exit result describes the full regression suite, separately from baseline closure.
With no workload limit, the launcher has no hidden SSH deadline.
Keep the terminal open for `all`; use the detached command for a replay across work sessions.

Use a bounded selection while developing capture scripts:

```sh
PERF_LAB_SECONDS=900 PERF_LAB_SCOPE=routes PERF_LAB_STATES=cold,warm,offline npm run perf:lab -- walk 200
```

`PERF_LAB_SECONDS` limits each workload phase, excluding setup and transfer.
A full-profile replay can need more than 1800 seconds.
A 900-second control run already expires before either scored date completes.
A timeout does not establish capture overhead as the cause.
Use the detached command for acceptance replays. Do not repeat short runs to prove the two-day gates.
`PERF_LAB_CASES` selects exact matrix IDs, separated by commas.
`PERF_LAB_ROLES` accepts `commissioner,member`.
`PERF_LAB_DAYS` accepts `in-progress,final`.
Completed cases resume only when source fingerprints and artifact hashes match.
A source or adapter change requires fresh proofs; archived measurements remain available.

## Detached replay

Run a long replay from the Mac without keeping SSH open:

```sh
npm run perf:lab -- replay-detached
```

Leave `PERF_LAB_SECONDS` unset. The replay has no wall cutoff.
The command restores the backup on the mini and runs with `nohup`.
It writes `evidence/detached-latest.json` on the Mac.
That receipt names the source, command, PID, log, and exit-code file.
Read the log and confirm the recorded PID before resuming work.
After the replay exits, collect it before starting another workload:

```sh
npm run perf:lab -- collect RUN_ID
```

Replace `RUN_ID` with the value in `detached-latest.json`.

Collection refuses a live job, missing exit code, mismatched receipt, or unfinished cleanup.
It copies checked artifacts and regenerates both reports without starting a stack.
The replay stops its stack in its normal cleanup path.
Check `lab/database-run.json` for `cleanup: true` after collecting the result.
Do not start another stack or sync source while this stack exists.
The source-sync command refuses an active private stack.

Use the PID and exit file together. A quiet log does not mean the replay stopped.
Do not start screen fixtures while the replay runs.

Use the approved lighter profile after a recorded full-capture resource failure:

```sh
PERF_LAB_CAPTURE_PROFILE=control npm run perf:lab -- replay-detached
```

It keeps the same cadence and gates, with reduced logging.
Do not classify it as full-profile capture evidence.

## Profiles and gates

`full` records HTTP requests, Edge requests, cache events, pushes and complete SQL statistics.
`pg_stat_statements.track=all` retains nested statements, rows and buffers.
Statement text logging stays off. Automatic plans sample 1% of statements taking at least 25 ms.
The five synthetic clock wrappers omit their nested plan logging.
The SQL stream stops at 64 MiB and disables further automatic plans.
Worker and console logs stop at 64 MiB and record discarded byte counts.
Other append-only captures and JSON files have a 1 GiB limit. Exceeding that limit fails capture.
`database-run.json` records the bounded-v1 policy and SQL capture limits.
It also records VM disk use before restore and before the workload.

`control` suppresses detailed SQL logging and Edge outbound request capture.
It retains SQL statistics and the same product cadence and assertions.
Control gates can complete the replay acceptance under the approved lighter-profile fallback.
They do not prove full-profile timing or capture completeness.
`simulationPassed` records the accepted replay gates. `fullCapturePassed` records full-profile success separately.
The database runs out of disk during the full capture on 2026-10-28.
The user confirms another lane’s SQL logs filled the shared VM. Disk use is now 21%.
Its SQL log contains 22,521,802,680 raw bytes and 1,929,849,364 compressed bytes.
The Edge log records `No space left on device` for worker completion writes.
Six of nine gates pass before this environment failure.
The stack cleanup passes. No full-run timing gain is proven.
The running detached replay uses `PERF_LAB_CAPTURE_PROFILE=control` with the same cadence and gates.
It keeps its original source while running. New capture limits apply to later runs.
The reports show each profile separately.

The latest control replay stops in `matchup-forecast` with PostgreSQL error `55P03`: a statement reaches its lock timeout.
Four gates pass: live ticks and trade proposal, counter and acceptance.
The forecast gate fails. The other four gates remain incomplete because the replay stops before their final checks.
This failure occurs with detailed SQL logging suppressed. The capture does not identify the blocking transaction.
The matched 700-call segment remains 11.46 minutes. The terminal worker span is 34.20 minutes; it is not a completed two-day run.
No full-run performance gain is accepted.

The replay covers two scored dates and the preceding overnight period.
It uses live ticks, finalization, pre-tipoff lineups, waivers, trades, forecasts, and realtime checks.
Checkpoint tools come from the mini's existing PostgreSQL 17.6 installation.
Preflight requires both `pg_dump` and `pg_restore`.
Each new replay receives a separate checkpoint directory.

## HTTPS and phone review

The export uses a mkcert certificate for the mini's hostname and LAN address.
Open `https://michaels-mac-mini.local:57284` while a screen workload runs.
Copy `~/pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab/certs/rootCA.pem` from the mini to the iPhone.
Install it through Settings → General → VPN & Device Management.
Enable its trust under Settings → General → About → Certificate Trust Settings.
Use Safari's Add to Home Screen command.
Remove the lab certificate when it is no longer needed.

Automation uses Playwright WebKit with an iPhone profile and standalone-display emulation.
Installed iOS PWA: not proven on device.
No Xcode or Simulator installation is required.

## Evidence

Mac evidence root: `~/Documents/pancake-season-mission/fable/program3/evidence/`.
Mini evidence root: `~/pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab/evidence/`.

| Path | Contents |
| --- | --- |
| `lab/database-run.json` | Source, restore, profile, and cleanup result |
| `lab/walk.json` | Screen assertions and artifact hashes |
| `lab/*/` | Per-screen HAR, first/settled images, cache, SQL, and push evidence |
| `lab/postgres-statements.log.gz` | Detailed SQL log |
| `lab/job-load-replay.json` | Replay SQL rankings and table counters |
| `lab/edge.log.limit.json`, `lab/console-output.json` | Output limits and discarded byte counts |
| `lab/two-day.json` | Named gate results and failure reason |
| `lab/baseline.json`, `lab/baseline.md` | Screen, control, asset, endpoint, and SQL rankings |
| `lab/history/<run>/` | Previous captures |
| `first-load/index.html` | Paired images for visual review |
| `first-load/manifest.json` | Image sources and hashes |

The final command writes `data-flow.md` and `screen-matrix.md` inside the selected external evidence directory.
`lab/baseline.json` stores exact numbers; the Markdown reports round values for display.
Its `ranking`, `interactionRanking`, `networkRanking`, `replayNetwork`, and `runtime` fields hold current measurements.
Its `cohort` field holds the explicit historical release sample and its evidence paths.
Its `perScreen` field holds the final cold, warm and offline table, with a source and evidence path for each sample.
The screen phase moves into `lab/history/<run>/` when the separate replay phase starts.
Matching source fingerprints let the final report retain those screen proofs.
A later screen walk also retains a completed replay when its backend source trees still match.
The report checks committed `core`, Edge, migration and SQL trees before accepting those gates.
It keeps the replay's original source, profile, artifact hashes, timings and evidence path.
A failed new replay takes precedence over any older pass.

Legacy SQL logs larger than 128 MiB remain on the mini.
Their `remote-artifact.json` records the size, SHA-256, current path, and archive path.
Use the archive path after a later run moves the evidence into history.
Optional historical inputs stay in the external evidence directory under `baselines/`.
Missing history is reported as unmeasured; current gates still require current evidence.
The reports separate historical measurements from current proofs.

Regenerate reports after a completed transfer:

```sh
node scripts/perf-lab/report.mjs ~/Documents/pancake-season-mission/fable/program3/evidence/lab
node scripts/perf-lab/review.mjs ~/Documents/pancake-season-mission/fable/program3/evidence/first-load
```

The generated `data-flow.md` ranks asset, endpoint, control, and SQL costs by measured frequency.
The permanent [data-flow guide](data-flow.md) describes application contracts.
`docs/screen-matrix.md` keeps unproved states and controls red.
The opening tables separate the original cold and warm requests by asset and endpoint.
The release cohort takes one latest successful sample per case from its explicit source list.
It retains each sample's source and evidence path in `lab/baseline.json`.
Different capture fingerprints remain archived costs, not current coverage proofs.
The detailed tables retain earlier measurements, failed captures, and each replay attempt.
A content pass does not prove useful content appears in the first frame.
Normal-cadence and slow search still exceed their request budgets.

Capture actions select visible controls inside the active dialog first.
Sign-in and sign-up flows start without a saved login.
Filter cases first select the default sort through the UI.
They check each selected label, dismiss the filter sheet, and verify the resulting player list.
Result checks match the cached response's league, member, and request parameters to rendered names.
Sort checks also match the visible row order to the newest saved response.
An empty response also requires the visible empty-list message.
Pagination requires a visible player from a response with an offset of at least 20.
These checks do not independently prove database filter logic.
Section text must appear inside its active panel.
Matching text elsewhere cannot satisfy that panel's content or first-paint check.
A server-change check first proves the old content is visible.
It then changes fixture data and checks the new content.
Actions wait up to two seconds for network silence.
Continuing background traffic records `networkQuiet: false`; the content assertion still must pass.
Outgoing trades expose Edit; incoming trades expose Accept.
Trade previews use a read request; they do not invalidate their own cached view.
The Edge wrapper forwards internal function calls to the local runtime on57281.
Roster-plan choice cases require the receiving manager.

The launcher stops its services and removes temporary backup and secret files.
If interrupted, inspect the recorded PIDs and cleanup receipt before starting another stack.

The detached replay keeps its original source checkout until it exits.
Prepare later capture changes in the Mac worktree and transfer a bundle without checking it out during replay.
Do not run screen fixtures against the replay database.
Adapter-only WebKit checks use a separate checkout and mocked pages.
They prove capture behavior, but add no application coverage to the matrix.

After collecting the replay, verify the repaired Analyzer flow first:

```sh
PERF_LAB_CASES=interaction.trades-analyzer-offline-light.result/member/in-progress/cold npm run perf:lab -- walk 1
```

Then capture the direct Analyzer tab and its modes:

```sh
PERF_LAB_SURFACE=trades.analyzer,interaction.perf-analyzer-mode.multi-team,interaction.perf-analyzer-mode.two-team,interaction.perf-analyzer-team.choose,interaction.perf-analyzer-team.remove PERF_LAB_STATES=cold,warm,offline npm run perf:lab -- walk
```

Run `npm run perf:lab -- all` for the complete matrix and isolated two-day gates.
Selected runs do not satisfy the complete matrix.

## Restored player images

The lab records NBA headshots and legacy Sleeper player images before the browser walk.
It maps only validated Sleeper player-image URLs to the local HTTPS gateway.
The image bytes, source URL, cache headers and hash remain in `external-headshot-fixtures.json`.
The browser network guard remains closed to external hosts.
The mapped URL changes transport bytes in player responses; the report includes those local bytes.

The legacy-image correction passes its real-app check.
The empty rankings case changes from 54 requests and 5,307,653 bytes to 55 requests and 5,371,546 bytes.
Blocked external requests change from four to zero. The new local image contains 63,736 bytes.
This restores a missing image. It is not a performance gain.

## Analyzer regression

Run the real-app WebKit check after the active replay releases the stack:

```sh
npm run test:perf-lab:analyzer
```

It checks the complete offline revaluation flow and all Analyzer controls in cold, warm and offline states.
It writes `lab/analyzer-verification.json` and the usual per-case evidence.
Its exit code describes those 16 cases. The complete matrix has a separate acceptance result.

## Integration checks

An integration can assign its own private folder, project, ports, and evidence folder.
Use the same assignments for every command in that run.

```sh
PERF_LAB_LANE=fable-r27 PERF_LAB_PROJECT=pt4bafabler27 PERF_LAB_PORT_PREFIX=600 \
  PERF_LAB_EVIDENCE_ROOT=/tmp/fable-r27-lab PERF_LAB_RESTORE=0 \
  PERF_LAB_TLS_SELF_SIGNED=1 npm run test:perf-lab:closure
```

This command uses synthetic screen fixtures on a fresh private database.
It does not restore the backup or fetch season replay inputs.
It uses the installed OpenSSL for a temporary browser certificate.
It adds no dependency and keeps the historical ranked baseline unchanged.
Its 57 WebKit cases cover 41 screen adapters, Analyzer controls, and offline revaluation.
The screen checks include Daily Total placement, matchup navigation, Schedule, and selected-day lineup controls.
They do not establish a new performance baseline or an installed iPhone PWA result.
