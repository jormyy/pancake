# Historical season simulator

The simulator replays historical NBA activity through the real local data pipeline. Synthetic managers use authenticated app API actions on the same timeline.
A completed fixture download does not prove a completed season. Only the final replay report establishes full-run acceptance.

## Pipeline and invariants

The driver invokes production cron-dispatch SQL at planned times. `pg_net` sends real HTTP requests to the local router.
Deno imports the real Edge entrypoints. Their upstream requests reach a local server backed by verified historical fixtures.
The handlers use real PostgREST, database functions, locks, authorization, scoring, and notification records.
Synthetic users complete an auction, manage lineups and rosters, use waivers and trades, and exercise IR and taxi rules.
The boundary handler creates playoffs, waits through the grace period, rolls over the season, and starts the rookie draft.

Checks require live delivery before official finals. Dense dates require coverage in every regulation quarter.
Independent checks compare stored final fields, player fantasy points, lineup totals, and matchup results with the source fixtures.
Other checks protect lineup locks, roster and pick ownership, stale-response ordering, duplicate delivery, and retry recovery.
Next-day rechecks and an end-of-season repeat check recovery and idempotence. Raw official finals must always win over derived live values.

## Sources and provenance

Collection records each URL, retrieval time, HTTP status, byte count, and SHA-256 in `manifest.jsonl`.
Reads verify decompressed bytes. Fixtures remain outside the repository.

| Class | Content | Source or policy |
| --- | --- | --- |
| REAL-RAW | NBA final box scores and play-by-play; ESPN date scoreboards and game summaries | [NBA CDN](https://cdn.nba.com/static/json/) and [ESPN public API](https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard) |
| REAL-DERIVED | Normalized schedule, historical rosters, selected injury/news feeds, and live boxes | Transformations of recorded observations; original source paths remain in the manifest. |
| SYNTHETIC | Users, manager actions, invented draft prospects, unavailable-career responses, and fault overlays | Labeled simulator scenarios; these are not historical NBA events. |

The collection spans October 21, 2025 through April 12, 2026.
It contains 1,234 schedule entries: 1,230 played games and four postponements.
Each played game has a final box, play-by-play file, and ESPN summary.
The collection records 7,623 historical injury observations from NBA inactive reasons and 1,222 dated news or recap items.
These are fixture-coverage counts, not completed replay or unique-player counts.
Source: release evidence `sim/coverage.json` and `sim/provenance.md`.

Historical general-news snapshots and injury announcement times are unavailable. Dated recaps substitute for general news.
Current ESPN injuries and news stay outside historical feeds unless their dates qualify. Date-qualified injury candidates remain unverified.
Daily injury and postponement publication times follow declared derived policies. Makeup dates use recorded postponement notes.
Roster bootstrap uses first observed teams and introduces lookahead for later debuts. Historical career totals remain null.
Taxi and rookie tests use clearly named invented prospects; they do not prove historical career eligibility.

Eight pinned play-by-play counting-stat discrepancies remain documented in `known-discrepancies.json` and the source audit.
Derived live plus-minus differs from official finals; one game retains unresolved live-minute differences.
Those source limits never exempt final equality. Live boxes omit unconsumed CDN fields; raw finals retain the full provider shape.
The last recorded game-end event controls final availability. Later-dated revised actions do not receive invented timestamps.
See release evidence `sim/provenance.md`, `sim/snapshot-audit.json`, `sim/court-audit.json`, and `sim/source-time-audit.json`.

## Clock and dispatch limits

Database and Edge business time share a monotonic anchor. Live polling runs faster, while the clock stops at the next planned event.
Read-only checks pause business time. Native abort deadlines and the outer work limit retain real wall time.
This preserves pre-tipoff dispatch windows when real work takes longer than expected.

The local installer renames native PostgreSQL clock functions and installs replacements with new object identities.
It rebinds affected app functions, defaults, and policies. A catalog audit rejects uncovered business-time references.
Auth and extension internals retain native clocks. The restoration probe checks native time and preserves current backend function bodies.
No production clock seam is installed.

Real-time cron launching stays disabled on the isolated stack. The driver calls actual dispatch SQL in timeline order.
The transport uses `pg_net` through the task VM's host bridge. The local router requires internal authentication.
Host Deno execution does not measure hosted Edge startup, quotas, or production scheduler overlap.
A short replay or resumed failed run does not establish clean full-season acceptance.

## Fault overlays

The timeline injects stale boxes and scoreboards, duplicate finals, missing boxes, missing players, and missing schedule entries.
Other overlays cover CDN timeouts and 503s, an ESPN outage, sustained source failure, Edge shutdown, unreachable transport, and concurrent dispatch.
Recovery must use the same production handlers and database guards. Overlay responses and authenticated actions remain SYNTHETIC.
The final report separates delivery classes, actions, fault recovery, and invariant comparisons.

## Backend regressions found

Each defect has focused red/green evidence in release evidence `sim/defects.md`.

| Defect | Fixed behavior |
| --- | --- |
| SIM-B001 | Concurrent provider reads serialize persistence to avoid competing for the season write lock. |
| SIM-B002 | Atomic progress guards reject stale live boxes and scoreboards while retaining equal-clock corrections and official finals. |
| SIM-B003 | Scheduled games with a future `started_at` still trigger pre-tipoff automation. |
| SIM-B004 | A fresh scoreboard can reveal an existing live game during its scheduled polling backoff. |
| SIM-B005 | Rollover waits for an unpublished calendar and retains errors for invalid published calendars. |
| SIM-B006 | Recovery retries known transient source-lock conflicts without hiding persistent contention or refetching the provider box. |
| SIM-B007 | A reviewed CDN identity correction preserves the canonical player UUID and history; unreviewed conflicts still fail. |

The reviewed identity occurrence and its independent oracle remain pinned to source evidence. Raw historical boxes remain unchanged.

## Run

Use the [complete setup and cleanup recipe](../scripts/season-sim/README.md) on the mini after the capacity check.
Keep fixtures, state, generated local keys, and evidence outside the checkout. Never copy repository or profile environment files.
The simulator owns only `pt0493sim`: API/database ports 56221/56222, replay origin 56280, and router 56281.
Target guards reject other hosts and ports. Keys come only from that stack's local status output.

Collect and audit fixtures before replay:

```sh
npm run e2e:season-sim -- --collect
npm run e2e:season-sim -- --audit
```

A fresh full replay starts from the owned synthetic database reset described in the setup recipe:

```sh
npm run e2e:season-sim -- --replay
node scripts/season-sim/report.mjs
```

Short modes diagnose a limited window. They do not replace the fresh full replay:

```sh
npm run e2e:season-sim -- --replay --days 9
npm run e2e:season-sim -- --replay --start 2025-10-27 --days 1
npm run e2e:season-sim -- --lifecycle --start 2025-10-28
node --test scripts/season-sim/*.test.mjs
```

Preserve failed evidence before any reset. Never reset or sync source into a healthy active replay.
After verification, restore native clocks and stop only the owned stack using the setup recipe.

## Latest measured run

Full acceptance is true for the definitive release replay. All 174 dates complete from October 21, 2025 through April 12, 2026.
The final audit verifies 1,230 official finals and 43,265 matching player-game rows after rollover and the rookie draft.
The run records 1,967,064 invariant comparisons with zero failures. The final repeat audit covers 164 dates with games; ten dates have none.

| Day class | Dates | Games | Observed minimum live snapshots per game |
| --- | ---: | ---: | ---: |
| Standard | 112 | 799 | 1 |
| Fault | 8 | 62 | 8 |
| Seeded dense | 12 | 88 | 10 |
| Postponement | 8 | 56 | 9 |
| All-star | 14 | 67 | 10 |
| Playoff | 20 | 158 | 5 |

Each of these faults and its recovery occurs once: ESPN outage, missing schedule entry, CDN 503, timeout, missing box, missing final player,
Edge shutdown, and unreachable `pg_net` transport. Stale delivery, duplicate finals, and overlapping cron dispatch each occur once.
Sustained upstream and final-source outages each occur three times, with one catch-up event recorded for each scenario.
The real waiver worker clears eight expired holds at April 15 14:15Z. The boundary succeeds on its second attempt at 14:30Z.
Recovery stays within the 30-minute bound, with no manual claim or hold edits.

Three playoff matchups finish, rollover retains two league seasons and 47 prior matchups, and eight rookie picks complete.
No game or stat row is deleted. All 43,265 player-game rows still match official final fields after these transitions.
Execution takes 8,563.709 seconds; elapsed time including the pause is 9,202.359 seconds. Both remain below four hours.
The run starts at 21:02:27.881Z and finishes at 23:35:50.240Z on October 19, 2026.

The source is `7f145a12d36a5082542eaded620e3dc08693114f` plus six regular-season overlays and ten driver-only continuation files.
`round6-source-manifest2.json` pins the six overlays; `round7-source-manifest.json` pins the continuation files.
The performance scoring files remain unchanged. The earlier failed replay is excluded from these totals.

The run is interrupted at the playoff boundary by simulator driver bug SIM-H012.
It continues on the same retained database after a driver-only fix, with no backend change.
The report preserves the interruption; this is not an uninterrupted run.
Because of that bug, the real waiver worker is not dispatched daily from October 26 to the boundary.
Mid-season waiver-processing load is therefore under-represented.

Source: release evidence `sim/final-run.md`, `sim/final-run.json`, `sim/provenance.md`, and `sim/defects.md`.
Fault and recovery details remain in the reports named by `sim/final-run.json`.

Earlier partial and failed attempts remain diagnostic evidence. Their combined counts cannot establish one clean season.
The fixture totals above stay separate from delivered events and verified business behavior.
