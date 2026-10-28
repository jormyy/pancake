# Source monitoring

Pancake records source attempts, worker outcomes, and dispatch failures.
This document owns provider selection, schedules, recovery, and cleanup.

## Health contract

The configured-source report includes every enabled source and the disabled player fallback.

| Source | Freshness and coverage | Failure and recovery |
| --- | --- | --- |
| NBA CDN | Schedule, scoreboard, stats, and player sync runs; games, weeks, final stats, and NBA IDs | `sync_runs` records failures; cron retries polls |
| ESPN public JSON | Player sync and news dates; ESPN IDs and news rows | Player, injury, career-count, or news errors fail the run; daily sync retries components |
| Sleeper (RotoWire) projections | Latest attempt succeeds within eight days; current-week coverage reaches 300 distinct players in season | Shape and matching failures preserve stored player-game rows |
| FantasyPros projections | All three projection types have attempts within 48 hours | Failed or skipped runs retain reasons; valid fallback data remains available |
| Hashtag Basketball | Ranking sync and fetch dates; each view meets its row floor | Invalid views fail before replacement; weekly sync retries |
| NBA draft order | Draft sync run; at least 50 verified picks | Incomplete boards preserve stored data; each window day retries |
| Sleeper player fallback | Disabled while `PLAYER_SYNC_SOURCE` uses its default | No fallback request occurs until the source setting changes |

Run recorded recovery checks before the local health report:

```sh
npm run check:source-recovery
E2E_SOURCE_RECOVERY_VERIFIED=1 npm run e2e:source-health
```

The report requires a local database with source records.
Set the recovery flag only after the checks pass for the source under review.
FantasyPros zero-row skips can be expected during the offseason.
Sleeper projection freshness and coverage are also marked expected-unavailable then.
A successful empty scoreboard response differs from a failed request.

## Final statistics and corrections

Live polling revisits completed games from today and yesterday after thirty minutes.
A completed game can trigger that check without another live or scheduled game.
Recent attempts retain their thirty-minute retry limit.

The daily correction job starts at or after 06:20 Eastern and covers the previous seven dates.
The work dispatcher checks this gate every fifteen minutes and can catch up after downtime.
Each date window is queued once, including after completion.
The existing fenced dispatcher processes one game at a time and records failures.
The correction pass uses NBA final boxes and updates dependent totals through the normal stat writer.
Older source corrections require an explicit historical replay.
Check failed range jobs before treating a completed schedule check as proof of correct statistics.

## Injury refresh

`sync-player-injuries` refreshes injuries each quarter hour from 11:00 ET through the last scheduled tipoff.
Outside that window, it refreshes hourly from 08:00 through 02:00 ET.
The hourly rule also covers days without games.
The dispatcher sends `{}` and the worker records `sync_runs.function_name = 'sync-player-injuries'`.
`sync-players` keeps its daily full player, injury, career, and news refresh.
The source report includes recorded injury outcomes.
Before Edge deployment, an absent injury function returns HTTP 404 without alerts, rapid retries, or readiness failures.
After rollback, the new function can remain deployed or be absent.
Production data health checks stored data and does not require this function to exist.

## Projection schedules

`supabase/functions/sync-sleeper-projections` reads RotoWire per-game lines from Sleeper's public NBA projection endpoint.
It is the primary projection source. `supabase/functions/sync-projections` supplies FantasyPros backup values.
Pancake uses the season's ending year; Sleeper uses its starting year.
For example, Pancake season 2027 maps to Sleeper season 2026.
The first source week contains the first regular-season game and ends Sunday.
Later weeks run Monday through Sunday.

The SQL work dispatcher checks projection gates every fifteen minutes through `private.enqueue_projection_sync`.
All projection windows use `America/Los_Angeles`, including daylight saving changes.

| Source | Due work |
| --- | --- |
| Sleeper weekly snapshot | Monday 00:00 PT for that Monday–Sunday week, when the season calendar contains that week |
| Sleeper game-day refresh | 08:00, 12:00, and 15:00 PT while that day's first regular-season tipoff remains in the future |
| FantasyPros backup | 08:00 and 15:00 PT |

Late checks claim the current week and latest elapsed daily window.
The Sleeper worker selects the scoring week whose start and end contain today's Pacific date.
It does not require that scoring week to start during the current Monday–Sunday source window.
Multiweek scoring periods retain their scoring week number while Sleeper source weeks advance each Monday.
Days outside all scoring weeks return a successful skip with zero affected rows.
The skip records `No current regular-season projection week` and preserves stored projections without a provider request.
Game-day refreshes remain eligible after a failed Monday pull.
Dispatch claims and reconciliation use the shared retry rules below.
The game-day gate needs a known future first tipoff.

## Projection storage

`sleeper_projection_rows` holds the newest projection per `(player_id, source_game_id)`.
It stores no revision history.
`projection_sync_runs` records attempts, counts, HTTP status, and parser metadata.
`complete_sleeper_projection_sync` commits row changes and their completion record together.
Only the backend can call it. Authenticated clients can read stored projections.

Completion serializes writes within the season and week.
A row update requires an equal or newer provider `last_modified` value.
A snapshot that starts before a newer successful snapshot cannot replace it.
Such a completion records a skipped, superseded snapshot.

Completion compares incoming matched player-games with stored player-games dated today or later in Eastern Time for the same season and week.
Below 70% of the stored upcoming count, the pull inserts or updates received rows and deletes nothing.
The provider revision rule still applies to each update.
The run records failure with its row counts and coverage diagnostics.
`source_metadata.coverageGuard` records `storedUpcoming`, `matchedUpcoming`, `minimumPercent`, and `degraded`.
The worker reports this failure without overwriting the completion diagnostics.
Past games and other weeks do not affect the coverage comparison.

At 70% or more, or with no stored upcoming games, normal snapshot replacement runs.
It removes absent source games dated today or later in Eastern Time within the same season and week.
This removes stale future games when a team change produces different source game keys.
Source keys still present in the response protect stored rows rejected during parsing or matching.
Earlier dates remain until weekly cleanup.
Readers also reject upcoming old-team lines, as specified below.

Matching uses Sleeper IDs first.
A unique normalized name and team can match a player who has no Sleeper ID.
Runs record parsed, matched, unmatched, input, and rejected counts, plus up to thirty unmatched identities.
Missing stats become zero. Projected sits store zero lines and suppress backup values for that game.
Attempts increase to makes when provider rounding makes them inconsistent.
Unused stats do not affect validation.
More than 20% rejected rows fails the pull.
Invalid bodies, zero valid rows, no matched players, and HTTP failures preserve stored projections.
Recorded fixture tests make no live provider requests.

FantasyPros readers select the newest completed successful run per projection type and date or season/week.
A failed pull preserves the last successful run.
A successful pull removes older successful runs and their rows for the same scope, within the compaction budget.
This is a current-snapshot store; a cleanup backlog can temporarily retain superseded rows.

## Projection readers

`get_league_projection_rows` supplies player views, manual lineup optimization, and the pre-tipoff worker.
`private.pre_tipoff_input_fingerprint` uses the same resolved rows.
Readers prefer Sleeper for each player-game and use FantasyPros for uncovered games.
Internal projections and season averages remain the final fallbacks.
FantasyPros is ineligible when league scoring requires shooting makes or attempts that it does not supply.

A Sleeper row must match a regular-season scheduled matchup by date, team, and opponent.
Today and future rows must also match the player's current team.
Earlier games remain eligible after a team change.
The player detail query uses the next regular-season game for Sleeper selection.
Sleeper rows remain readable after 36 hours, with a false freshness flag and the recorded fetch time.
FantasyPros daily candidates require data within 36 hours; weekly candidates require data within eight days.

Weekly totals sum covered game lines and available fallback values.
Weekly averages divide by the number of covered games, including games filled by a fallback.
FantasyPros weekly totals divide by their reported game count before filling missing games.
Prior-team games remain in weekly totals and coverage counts.
A mixed week's source label names Sleeper even when backup values fill some games.

The league scoring function uses Sleeper makes and attempts.
Sleeper percentages divide total makes by total attempts, then multiply by 100.
Mixed percentages weight available provider percentages by game count because FantasyPros omits attempts.
The optimizer fingerprint includes resolved projection fields and freshness, but excludes the fetch timestamp.
Equal refreshes do not change that fingerprint unless another returned field changes.

## Scheduled work

One cron entry calls `public.dispatch_work()` each minute.
A second drains hints every 30 seconds.
A third prunes cron history at minute 12 each hour.
All three check the operator pause.
The replay derives these commands from migrations and preserves scheduled wakes.

`private.work_items` stores the kind, key, due time, attempts, lease, last error, and payload.
A kind and key identify one period or input revision.
One unfinished item per kind and payload prevents overlapping retries.
Pre-tipoff items share one active item per tipoff.
A dead item cannot prevent later items from running.

The dispatcher claims one item at a time with row locks that skip busy rows.
It claims at most eight items and allows at most eight active workers.
It starts no new item after two seconds.
The outer cron statement has a five-second budget and 250 ms lock budget.
Service-role statements have three-second and 250 ms budgets.
An advisory lock skips overlapping runs.
SQL maintenance runs in the dispatcher.
Business jobs use their existing Edge handlers.
The maintenance handler runs response vacuum outside a database transaction.
It uses the project's `SUPABASE_DB_URL` and adds no package dependency.
The direct SQL hint drain replaces three queued hint jobs and their delayed Edge invocation.
Empty drains write no application rows.

Each work claim grants a five-minute lease.
Workers renew every thirty seconds through the shared heartbeat helper.
Nested workers inherit its cancellation signal and database write fence.
Expired or replaced workers cannot write application tables or report completion.
An expired lease counts as a failed attempt.
Retries wait sixty seconds, then 120 seconds.
The delay formula doubles with a fifteen-minute cap.
The third failure moves the item to the dead letter state.
Later periods remain eligible.
Domain claims still protect individual games, tipoffs, and provider checkpoints.
They do not schedule another top-level attempt.

`public.work_dashboard()` returns due, running, failed, and dead counts for every kind.
Only the service role can read it or run the dispatcher.
An expired running item counts as failed until the next dispatch recovers it.
Successful work remains for seven days.
Dead items remain available for inspection.

### Work gates

The dispatcher preserves domain schedules as enqueue conditions.
These names identify queued work, not separate installed cron jobs.
Daily and weekly keys also preserve late-tick catch-up and repeat suppression.
ET means Eastern Time; PT means Pacific Time.
UTC windows retain their original calendar boundaries.

| Queue kind | Enqueue condition |
| --- | --- |
| `process-trades`  |  Every minute; expired pending trades, due accepted trades, or eligible notification deliveries or receipts. The notification scan still runs first. |
| `close-expired-nominations`  |  Every minute; active draft deadlines before the next minute, or opening-night snake completion work. |
| `stats-sync`  |  Every minute; pending ranges, eligible failed ranges, stale claims, or malformed ranges needing settlement. The horizon remains one minute. |
| `pre-tipoff`  |  Every minute; enabled current teams with an available scheduled tipoff within two minutes. Existing windows remain eligible until one minute after tipoff. Changed input fingerprints create a new revision after completion. |
| `live-poll`, `sync-scores`  |  Every even minute; no live poll lease, then eligible ingestion work. Otherwise, uncertified or unfinished closed weeks need scores, with the existing thirty-minute score throttle. |
| `season-boundary`, `setup-season-rollover`  |  Every fifteen minutes after 09:00 ET. Active, playoff, offseason, or drafting leagues get one boundary item per day. Setup rollover retains each eligible gate tick. |
| `sync-players`, `player-injuries`  |  Every fifteen minutes. Full players refresh once after 06:00 ET. Injuries refresh every fifteen minutes from 11:00 through the last valid tipoff, otherwise hourly from 08:00 through 02:00 ET. |
| `sync-schedule`  |  Minutes 05, 20, 35, and 50; once per day after 06:05 ET. |
| `process-waivers`  |  Every fifteen minutes; once per day after 03:00 ET, including both DST changes. Existing waiver eligibility and hold rules stay in the worker. |
| `pt:sleeper-week`, `pt:sleeper-day`, `pt:fantasypros`  |  Every fifteen minutes. Sleeper weekly follows a configured Pacific calendar week. Sleeper daily uses 08:00, 12:00, and 15:00 PT before first regular-season tipoff. FantasyPros uses 08:00 and 15:00 PT. |
| `sync-rankings`  |  Hourly; Monday after 07:00 ET or later in the ISO week. Each of `POINT_3`, `ROOKIE`, and `POINT_5` gets its own weekly key. |
| `sync-draft-order`  |  13:00 UTC on June 20–30. |
| `sync-draft-order`  |  13:00 UTC on July 1–15. |
| `daily-stat-corrections`  |  Every fifteen minutes after 06:20 ET; a final regular-season game exists in the preceding seven dates. The range job remains unique. |
| `matchup-forecasts`  |  Every minute; current, nonvoided forecast periods enter their existing discovery and expiry queue. Due dirty rows need an available three-minute claim. |
| `refresh-views`  |  Every minute; discover seasons, expire cached trade values, and enqueue due dirty rows without a current three-minute view claim. |
| `edge-invocation-reconcile`  |  Every five minutes when unresolved or running invocations exist. |
| `cleanup-trade-estimates`  |  Daily at 08:35 UTC. |
| `mock-room-expiry`  |  Daily at 09:30 UTC. |
| `pg-net-response-vacuum`  |  Minute 17 of every hour. |
| `trade-estimate`, `trade-activation` | Offer submission or accepted-trade activation queues internal API work. |
| `trade-publication` | A trade write queues its coalesced league events and screen invalidation. |
| `retention-prune`  |  Daily after 10:00 UTC, with one key per UTC date. |

The old `invoke_*_if_due` functions and daily dispatch wrappers are removed.
The old dispatch claim helpers and state table are removed.
The unused general lineup gate becomes `private.enqueue_lineup_optimizer` for explicit callers.
Its original today-through-seven-days predicate remains available.

### Verification

Run these recipes against an isolated stack with no active cron runner.
Keep its installed dispatcher entry present but inactive.

| Recipe | Evidence |
| --- | --- |
| `tests/db/work-queue-gates.sql` | Original nomination and stats claim cases, including the one-minute horizon. |
| `tests/db/work-queue-trades.sql` | Original trade and notification gates, delivery leases, and dead-letter exclusions. |
| `tests/db/work-queue-forecasts.sql` | Forecast discovery, expiry, publication fencing, and member access. |
| `tests/db/work-queue-schedules.sql` | Daily and weekly catch-up, ET and UTC windows, DST, injury cadence, maintenance, and half-minute drains. |
| `tests/db/work-queue-projections.sql` | Pacific projection windows and independence from dead weekly work. |
| `tests/db/work-queue-live-poll.sql` | Original ingestion eligibility, backoff, lease ownership, and stale-write cases. |
| `tests/db/work-queue-weekly-scoring.sql` | Closed-week scoring, certificates, playoffs, and the thirty-minute throttle. |
| `tests/db/work-queue-pre-tipoff.sql` | Original tipoff, injury, postponement, input revision, and stale-worker cases through the queue. Test retries make their due times current. |
| `tests/db/work-queue-lifecycle.sql` | Claims, retry delays, dead letters, lease recovery, write fences, completion correlation, and event deduplication. |
| `tests/db/league-events-outcomes.sql` | Claim, trade, lineup, and score outcomes; membership and failed-bid privacy. |

## League event log

`public.league_events` stores league, nullable member, kind, summary, detail, and creation time.
A completed item records `work.succeeded`; exhausted work records `work.dead`.
Global work has a null league and remains visible only to the service role.
League outcomes record `claim.awarded`, `claim.failed`, `trade.executed`, `trade.vetoed`, `lineup.auto_set`, and `scores.finalized`.
Most product outcomes commit with their underlying changes.
Trade writes queue their events and screen publication for a later transaction.
Repeated terminal updates and duplicate worker completions do not add another event.
League members can read their league's events.
Only the claim owner can read a failed claim event.
Clients cannot insert, update, or delete events.

## Invocation records

Each invocation retains its request ID and worker outcome.
Queue attempts also retain the work item and lease token on their invocation.
A finished worker result determines success or failure.
Transport timeouts do not override a finished worker result.
The reconciler retains the existing diagnostic response windows.
It no longer schedules retries through the retired dispatch state.

Stats range workers process at most one provider game per invocation.
Empty-date scans checkpoint after each 31-date batch.
They release after four batches or the one-second scan budget, which can overrun by one batch.
A failed checkpoint stops further work.

Live polling targets twenty-second ingestion intervals.
Each tick budgets eighteen seconds; each worker budgets 110 seconds.
An abort guard stops work at 115 seconds.
The live ingestion lease lasts ninety seconds and renews every thirty seconds.
Its enclosing work-item lease lasts five minutes.
Lease loss stops further writes.
One scoring pass follows each batch of game updates.
Missing final-game stats remain eligible for recovery.
Failed provider requests back off without marking the game complete.
A final NBA CDN box score with valid team scores also saves them and its status text as the game's Final scoreboard sample.
Later non-final scoreboard samples cannot overwrite that final score.

Response-table maintenance uses ordinary vacuum to reclaim expired response space.
It preserves live responses and requires no table rewrite.
Review table size, dead tuples, and reconciliation time before changing its frequency.

## Retention

The dispatcher enqueues one `retention-prune` work item each day after 10:00 UTC.
Daily keys catch up a late tick and prevent duplicate runs.
The work item calls `private.run_retention()` and preserves receipt and beacon cleanup.
The runner stops starting helpers after two seconds and skips locked rows.
Each deletion statement has its own bounded batch.
An advisory lock prevents overlapping retention runs.
A failed table records a short error; other tables can proceed.

`public.retention_dashboard()` requires backend access.
It lists every table, partition, and stored view in the application, Auth, Storage, cron, and network schemas.
Each row shows table bytes, total bytes, estimated rows, its rule, and its last check and prune.
A new table without a saved rule appears as an unassigned retention decision.
Each table has one cumulative prune summary; the job creates no growing run-history table.

| Records | Retention and preserved summary | Maximum deletion per call |
| --- | --- | --- |
| `sync_runs` | Finished success: seven days; failure: thirty days. Keep newest success and failure per function. | 5,000 |
| `edge_invocations` | Reconciled success: seven days; failure: thirty days. Keep newest terminal outcome per function. | 5,000 |
| `cron.job_run_details` | 24 hours for finished or abandoned runs. Active executions stay. Hourly pruning also applies. | 5,000 |
| `net._http_response` | Six hours. Unreconciled invocation responses stay. | 5,000 |
| `notification_outbox` | Sixty days after delivery, suppression, or dead letter. Pending work stays. | 5,000 |
| `sleeper_projection_rows` | Current Pacific week and future dates. | 5,000 |
| `projection_sync_runs` | Current Pacific scoring period and future periods. Delete expired children before runs. | 200 runs |
| `fantasypros_projection_rows` | Same period as the parent run. Current rows stay. | 5,000 |
| `sync_jobs` | Completed jobs: thirty days. Failed and pending resume checkpoints stay. | 5,000 |
| `lineup_tipoff_members` | Thirty days after a terminal dispatch. | 5,000 |
| `lineup_tipoff_dispatches` | Thirty days after finish. Delete only after member receipts expire. | 5,000 |
| `matchup_forecasts` | Seven days after validity and matchup end. | 5,000 |
| `private.matchup_forecast_queue` | Seven days after matchup end, or when voided. Active claims stay. | 5,000 |
| `trade_estimate_quotes` | Unlinked quotes: seven days after expiry. Frozen trade evidence stays. | 5,000 |
| `league_change_hints` | One live revision per league and topic. Delete orphan rows. | 5,000 |
| `auth.refresh_tokens` | Expired or ninety-day inactive sessions. Revoked tokens: seven days. | 5,000 |
| `auth.sessions` | Expired sessions: seven days. Inactive sessions: ninety days. Delete children first. | 500 |
| `private.request_receipts` | Seven days after creation. Preserve the existing replay-result expiry contract. | 5,000 |
| `public.perf_beacons` | Thirty days after receipt. | 5,000 |
| `private.work_items` | Successful items: seven days. Pending, running, failed, and dead items stay. | 5,000 |
| `private.trade_offer_requests` | Keep idempotency receipts with trade history. Operational cleanup never deletes them. | No expiry |
| Retention rules and summaries | One row per table. Keep cumulative deleted counts and the latest error. | Fixed by schema size |
| Provider history policy | One coverage rule per provider. | Fixed by provider count |
| Search caches, live leases, and source state | Replace rows by their existing entity keys. | Fixed by entity count |
| League history, NBA games, statistics, and news | Retain source records and product history with their owning entities. | No expiry |
| Auth and Storage support tables | Their services own lifecycle cleanup, except the session and token rules above. | Service owned |
| Browser screen cache | At most 48 entries and 4 MiB of JSON, with version-based invalidation. | Client owned |
| Other browser caches | At most 64 ordinary entries, with smaller per-prefix limits. Ordinary entries expire after one day; membership entries after thirty days. | Client owned |
| Browser auth, preferences, and editor drafts | Replace fixed keys. Session drafts clear on close, send, sign-out, or account change. | Client owned |
| Avatar files | Upsert one file per supported format per user. Each file is at most 5 MB. | Three current format paths per user |
| Vercel and Edge logs | External provider retention. The application stores no second log copy. | External |
| Replay receipts | Verified summaries remain in replay artifacts after raw database logs expire. | Replay artifact lifecycle |

Abandoned sync and invocation logs become terminal after thirty days.
Each run closes at most 5,000 abandoned rows per table.
The ordinary failure window then applies.
Projection deletion suppresses resource hints and restores the prior cleanup setting.
Run deletion waits for child deletion, so cascades cannot bypass the row budget.
Deletes free reusable space; they do not immediately shrink relation files.

The inherited projection growth estimate is about 5 MB per day.
Daily pruning removes the weekly scheduling delay, but this run does not measure hosted disk savings.
Use dashboard sizes and backlog errors before changing batch limits.
Auth and Storage metadata sizes exclude the stored file bytes.
Storage files require deletion through the Storage API; SQL metadata deletion can orphan blobs.
Deleted-user avatar files still need a Storage lifecycle worker.

The combined schema includes work items, request receipts, league events, and performance beacons.
Queue leases, retries, outcome events, and view refresh remain in the single dispatcher.
Remaining event-history retention rules still need a lifetime or summary decision.
Durable product history, failed resume checkpoints, and saved replay files still need a separate lifetime or summary decision.
These exceptions prevent a claim that every stored byte has bounded lifetime.

## Runs forever

Historical backfill reads completed seasons from the published calendar.
New completed seasons join its plan without a source-code edit.
Provider coverage dates and career baseline seasons come from `private.provider_history_policy`.
The CDN game identifier uses the previous season's final two digits.
Playoff generation and season transitions use saved league settings instead of the redundant week-twenty fallback.

`tests/db/retention-daily.sql` fills expiring stores and checks exact retained rows, batch limits, receipt survival, and cumulative summaries.
A disabled projection pruner makes its projection-budget assertion fail.
`tests/db/retention-queue.sql` checks daily catch-up, receipt and beacon expiry, completed work cleanup, and completion events through the dispatcher.
`tests/db/retention-timeout.sql` forces a slow worker and proves that cancellation stops the run before another batch.
`tests/db/forever-assumptions.sql` checks changed provider coverage and automatic inclusion of the next completed season.
`tests/db/forever-two-seasons.sql` walks all 730 days across two fixture years using the SQL calendar and boundary functions.
It publishes different season lengths, completes rookie drafts, certifies fixture scores, advances playoffs, and rolls over twice.
The private database run covers 358 offseason days; each boundary call stays below one second.
These fixtures prove SQL boundary behavior; they do not run every Edge provider job.
The replay catalog includes the dispatcher, half-minute hint drain, and hourly cron-history pruning.
Daily retention remains queued work.

| Changed reader | Removed assumption |
| --- | --- |
| `supabase/functions/backfill/index.ts` | Fixed CDN and Basketball Reference season lists |
| `supabase/functions/_shared/cdnBackfill.ts` | Game identifier subtraction from a fixed base year |
| `private.player_career_appearances` | Fixed provider coverage date |
| `private.player_career_fallback` | Fixed provider coverage season, date, and baseline season |
| `public.complete_player_career_base_atomic` | Fixed minimum career coverage season |
| `public.generate_playoff_bracket_atomic` | Week-twenty fallback |
| `public.apply_season_boundary_after_grace` | Week-twenty fallback |

Run these four recipes against the isolated database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/retention-daily.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/retention-timeout.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/forever-assumptions.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/forever-two-seasons.sql
```

The private database passes 58 retention checks, the timeout control, nine provider-policy checks, and sixteen boundary checks.
Existing retention, career, career-queue, playoff-window, and playoff-boundary recipes also pass.
Both loopback CDN continuation recipes preserve prior rows after a failed continuation and successful retry.
Function source, function catalog, generated database types, shared Edge output, and changed Edge entrypoints pass their checks.
These earlier retention checks do not establish a result for the current full application suite.
The [integration record](release-2.4-integration.md) records the merged release checks.

The runtime audit finds no active season-year assignment literal in these source trees.
Comments, a leap-year date anchor, timestamp bin origins, Unicode escapes, and byte limits still contain year-shaped numbers.
Migration seed values record provider history policy; historical migrations remain unchanged.

The audit still finds draft-publication month gates, thirty-team checks, eighty-game schedule checks, and fixed schedule-publication months.
Roster completeness checks also retain player-count bounds.
Several providers still use literal default endpoint paths.
Removing these guards requires authoritative publication and provider-shape state; accepting incomplete lists can erase valid data.
The dispatcher supplies persisted retries. The two-season recipe still needs a queue-based acceptance walk.
A full provider replay and the every-job offseason timing proof remain unverified.

## Player sources and participation

`PLAYER_SYNC_SOURCE` defaults to `espn`; `sleeper` enables the separate player fallback.
ESPN supplies names, teams, coarse positions, injuries, and news.
Sync preserves finer existing position eligibility.
NBA CDN supplies NBA identities. Existing Sleeper identities remain resolvable.
A box player can join an existing ESPN identity when NBA ID matching fails.
The match requires the same name words, a unique player on that side, and a corroborating ESPN team listing before tipoff.
The ESPN row must have no NBA ID and no later conflicting team listing.
An earlier CDN-only identity then merges into that row.
The matcher does not use jersey numbers, nicknames, prefixes, or spelling distance.

Truncated master lists fail before replacement.
A complete ESPN refresh does not prove an omitted player left his team.
Stored boxes can also omit signed players for long periods.
An omitted player changes team only when a later stored regular-season or postseason box proves a different team context.
That box must follow his latest ESPN placement or stored box for the old team.
The player moves to the recorded box side; without a side, his team clears.
Every box writer records sides before importing its players.
Identity merges preserve side records and the latest ESPN listing interval.
A later ESPN listing can update the team again.

Other omitted players retain their team and appear in `releaseHeld` diagnostics.
The player row, IDs, injury, ownership, and lineups remain intact.
The NBA identity step runs before the release sweep.
Any listing gap, import failure, or identity-step failure skips that sweep and records `releaseSkipped` reasons.
[Roster lifecycle](roster-lifecycle.md#taxi-eligibility-and-trade-plans) owns rookie and career-game taxi eligibility.

`npm run parity:players` compares the public player feeds and writes ignored test artifacts.
The CDN writer honors explicit played flags before the minutes fallback.
Zero means DNP. One means played, including zero minutes.
Missing or invalid flags use parsed minutes; missing or malformed minutes indicate DNP.
Raw stat fields remain stored. Scoring excludes DNP rows.
Eligible syncs can correct existing rows.
Completed backfill jobs do not automatically replay.
Current season totals update through database triggers; other derived readers retain their own refresh rules.

## Recovery

1. Read the latest failed run and error.
2. Compare worker and transport outcomes for `cron:` records.
3. Confirm the upstream shape with a read-only request.
4. Fix the parser, endpoint, or credentials in development.
5. Run recorded recovery checks and one healthy local sync.
6. Confirm a newer success and complete row counts.

Fetch and parse failures preserve stored data.
Coverage failures preserve omitted games while applying accepted row updates.
Notification failures retain retry and dead-letter state.
Queryable failures do not establish an external alert destination.
The owner selects a destination and authorizes its delivery integration.

## Player identity and roster coverage

The daily import reads ESPN rosters, the NBA active-player index, and Sleeper player identities.
The NBA index adds missing current players and fills missing NBA IDs, experience, and positions.
Sleeper enriches matching players without replacing the roster source or injury state.
Names use case-insensitive letters only, with team aliases normalized.
A source ID links only to one compatible player on that NBA team.
A different non-null ID is never overwritten; ambiguous records remain review items.
An already-owned source ID can merge its box row with the one compatible roster row through the existing merge function.
Injury player-card links supply ESPN IDs before the injury update in the same run.
Projection rows supply Sleeper IDs before projections are matched and saved.
Unknown source records do not create players during injury or projection refreshes.

A complete roster cycle requires both ESPN and NBA to cover all 30 teams and at least 350 players each.
Every listed source ID must resolve before the cycle records membership.
One-source omissions, partial cycles, and older cycles cannot remove team membership.
Partial NBA rosters report `rosterRefreshSkipped`; they do not fail an otherwise successful sync.
Provider fetch failures and identity-write failures remain sync failures.
Two complete cycles at least 24 hours apart can clear a player absent from both sources.
A gap of more than 36 hours restarts that absence period.
A newer ESPN listing or NBA box also restarts it.
The single-source release hold remains in `espn_release`.
The separate two-source cycle establishes sustained absence.
Clearing a stale team preserves IDs, stats, ownership, and the existing unassigned-player list.
The team-filtered Players list then excludes that row.

Injuries refresh every 15 minutes from 11:00 ET through the last tip-off on game days.
Outside that window, they refresh hourly from 08:00 through 02:00 ET, including days without games.
The queue supplies retries and dispatch. The injuries handler still receives an empty body.
Run `supabase/sql/player-data-audit.sql` to inspect missing source fields and pending absence holds.

Historical CDN and Basketball Reference imports persist final team scores before marking player statistics complete.
Their completion regressions verify stored scores and preserve prior data on failed refreshes.

Final NBA snapshots retain the provider publication time.
Verified corrections set a newer revision.
The database rejects unversioned writes or skips older snapshots.
Scores and stat rows commit together for each accepted revision.

## Operator pause and current verification

Use `public.set_worker_paused(true, reason)` before investigating sustained database load.
Only the service role and database owner can change it.
The pause stops new scheduling, claims, hint drains, and hourly cron pruning.
It does not cancel running statements or workers.
Inspect `work_dashboard()`, `retention_dashboard()`, and invocation outcomes before resuming.
Use `public.set_worker_paused(false, reason)` after the checks pass.
The [release runbook](../supabase/RELEASE-DB.md#worker-incident-controls) gives the ordered procedure.

Run queue lifecycle, schedule, lease, retention, and IO fixtures on a disposable local stack.
The [IO audit](io-audit.md) records the final integration measurements and negative controls.
The [integration record](release-2.4-integration.md) keeps the historical check results.
No source-health report alone proves end-to-end browser freshness.
