# Historical season simulator

The simulator drives the real local ingestion pipeline and authenticated app actions on one monotonic timeline.
The external handoff and final-run.json contain measured completion status. Code paths alone do not prove a full replay.

## Targets and setup

Run heavy work only in `~/pancake-t_04935f0d/lanes/sim/repo` on the assigned Mac mini.
Source `~/pancake-t_04935f0d/env.sh` first. Check fleet capacity before each heavy job.
Store fixtures, state, and evidence beside `repo`.

The database uses loopback port 56222. Auth and PostgREST use loopback port 56221.
The replay origin uses 56280. The Deno router uses 56281.
Writes reject remote hosts, other ports, and the production reference.
The guarded Docker helper can execute SQL only inside `supabase_db_pt0493sim` with its assigned host port.

`local-stack.mjs` exports `setupStack()` for setup from the mini checkout.
It uses the task-local official `tools/supabase-go` binary, disables cron launch before migrations, and unschedules all cron jobs.
It changes `supabase/config.toml` only in the mini copy. Never sync that file back.
`runtime.mjs` reads only this stack's local keys. It creates a fresh internal token in memory.
No command reads a repository or profile environment file.

## Commands

```sh
npm run e2e:season-sim -- --collect
npm run e2e:season-sim -- --collect --days 2 --games 20
npm run e2e:season-sim -- --audit
npm run e2e:season-sim -- --replay --start 2025-10-27 --days 1
npm run e2e:season-sim -- --lifecycle --start 2025-10-28
node scripts/season-sim/fault-run.mjs 2025-10-26
node scripts/season-sim/verify.mjs
node scripts/season-sim/verify.mjs --live-recipe
node scripts/season-sim/verify.mjs --clock-roundtrip
node --test scripts/season-sim/*.test.mjs
```

Replay defaults to all 174 regular-season dates, followed by playoff grace, rollover, and a rookie draft.
Use `--days 9` for the integrated opening action and fault scenarios.
Use `--start 2025-10-27 --days 1` for a small ingestion check without the full lifecycle.
Start from a fresh owned project volume for a fresh-ingestion acceptance run:

```sh
../tools/supabase-go stop --project-id pt0493sim --no-backup
node --input-type=module -e 'import { setupStack } from "./scripts/season-sim/local-stack.mjs"; await setupStack()'
npm run e2e:season-sim -- --replay
node scripts/season-sim/report.mjs
../tools/supabase-go stop --project-id pt0493sim
```

The explicit reset deletes only synthetic local database state. Fixtures and evidence remain outside the repository.
Check capacity first and preserve failed-run evidence before resetting.
The simulator creates four Auth users and completes the auction before opening night.
Daily phases cover lineups, lock rejection, optimizer preferences, waivers, adds/drops, IR, trades, and taxi.
The commissioner skips the short February 9–12 week before All-Star.
February 13–18 has no published fantasy week, so the simulator performs no lineup actions on those dates. Empty manual lineups create a tied regular-season result.
The real boundary function generates and advances playoffs, waits 48 hours, and rolls over the season.
The rookie draft uses traded pick ownership and a snake order.
Invented prospects enter through the real draft-board ingestion; their provenance is SYNTHETIC.

Standard dates require at least one in-progress box per game.
Dense dates require a box in each regulation quarter.
The dense selection uses seed 493 and covers every month, postponement/makeup boundaries, All-Star weeks, fault dates, and playoff weeks.
Overlapping games share dispatch times. Every game still receives real pre-tip dispatch and its official final.
The pipeline retains its six 20-second live ticks; the shared clock runs at 20x during these workers.
AbortSignal work deadlines and timers longer than the 110-second live loop retain real wall time.
Short polling waits, retry delays, interval heartbeats, and callback-based upstream timeouts scale with the shared clock.
Pre-tip windows reserve three minutes for live work.
The DB and Edge clock stop at the next planned event if slow real work uses that margin.
Read-only checks run with the clock paused. Live workers keep all six ticks and native work deadlines.
The planner keeps the first sample before the Eastern scoreboard date changes.
Coverage checks inspect actual deliveries, not only the planned timestamps.

Faults run inside the timeline: stale boxes/scoreboards, duplicate finals, missing boxes/players/schedule entries,
CDN timeouts/503, ESPN outage, a sustained upstream outage, Edge shutdown, unreachable pg_net, and overlapping dispatches.
Next-day rechecks and an end-of-season repeat of every date verify final recovery and idempotence.
Standalone lifecycle and fault commands remain diagnostic tools; they do not count as season proof.

`replay-checkpoint.json` and `replay-progress.md` persist each phase.
`upstream-summary.json` keeps complete class/path/game counters.
`upstream-events.jsonl` keeps the first 5,000 requests and every 100th later request.
Database statement statistics reset at run start; table reads use before/after deltas.

## Historical sources

Fixtures remain gzip-compressed outside the repository.
`manifest.jsonl` records URL, retrieval time, HTTP status, raw bytes, and SHA-256.
Reads verify the decompressed bytes against that manifest.
Downloads use two workers, delays, bounded retries, and content-addressed storage.

The 2025–26 regular season has 1,230 played games and four recorded postponements.
NBA final boxes/PBP and ESPN date scoreboards/summaries are REAL-RAW.
Normalized schedules, historical rosters, injury feeds, news selection, and live snapshots are REAL-DERIVED.
Synthetic users, actions, missing-career responses, and fault overlays are SYNTHETIC.
The origin preserves raw final box bytes. Complete delivery classes remain in `upstream-summary.json`.

Historical injuries come from box-score inactive reasons. Historical recaps replace general news.
Current ESPN summary injuries/news are excluded from historical feeds unless their dates qualify.
Historical announcement times are unavailable. Daily injury delivery and postponement publication timing are derived.
Makeup dates come from explicit ESPN postponement notes, including March makeups.
The derived daily policy publishes Postponed on the original date and the makeup on the next Eastern date.
This permits next-day makeups to reach the real schedule sync before tipoff.
Roster bootstrap uses each player's first observed historical team when no earlier observation exists.
This introduces lookahead for players who debut later. Historical career totals remain unavailable and stay null.
Taxi and rookie scenarios use labeled synthetic draft prospects, not invented career totals for historical NBA players.

Eight exact PBP counting-stat discrepancies are documented in `known-discrepancies.json`.
The audit accepts only those exact differences and retains a changed-final negative control.
Live PBP values arrive first; the official final must win.
Final availability uses the last recorded game-end event plus 60 seconds.
Game 0022500232 has 277 later-dated actions. Live windows exclude those actions; their raw records remain intact.
Game 0022500104 has two end markers. The last marker controls final delivery.
`source-time-audit.json` records these anomalies. `plan-audit.mjs` checks every game before replay.

Minutes and plus-minus derive from substitutions, period starters, game clocks, and scoring events.
The court audit resolves all game lineups, but reports one game with minute differences and widespread plus-minus differences.
These differences remain unresolved. They are separate from the eight accepted counting-stat discrepancies.
Live responses currently project consumed box-score fields and omit other CDN statistics.
That projection remains a source-shape limitation. Final responses preserve the complete provider schema.

## Clock and dispatch

The local installer renames four native PostgreSQL clock functions and creates new-OID replacements.
A replacement at the original builtin OID does not override PostgreSQL's fast path.
The installer rebinds app functions, argument defaults, table defaults, and affected RLS policies.
The catalog audit covers public/private functions, defaults, policies, views, and constraints.
It refuses uncovered CURRENT_*, LOCAL*, timeofday, or residual native-clock references.
Auth and extension internals retain native clocks. Those internals do not supply app business time.
The restore/reinstall probe verifies native time and preserves current backend function bodies.
Restoration keeps cron disabled and preserves evidence tables.

Deno 2.7.14 imports the real function entrypoints. A wrapper supplies Date and scaled timers.
Existing upstream-origin environment variables point to the replay server.
The real `net.http_post` connects through `host.lima.internal` to the loopback-bound router.
The router requires the internal token on gateway requests. It records function wall time.
API continuation requests route to the same real handlers.
No production clock seam or ingestion mock is installed.

## Source limits

The fixture audit pins eight provider counting-stat discrepancies. None exempts final equality.
Derived live plus-minus differs from official final values across all games.
Game 0022500093 has live-minute reconstruction differences beyond the 1.1-second audit tolerance.
Injury and postponement announcement times are inferred from game observations, not historical timestamps.
These caveats remain in provenance.md even when the pipeline replay passes.

The raw January 21 box gives Dillon Jones an alternate provider ID. The reviewed correction preserves his player UUID and history. `node scripts/season-sim/audit-identities.mjs` checks all historical boxes against the pinned source evidence. The current player-index supplement is not historical replay input.
