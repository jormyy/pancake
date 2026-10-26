# Source monitoring

Pancake records source attempts, worker outcomes, and dispatch failures. This document owns provider selection, projection storage, schedules, recovery, and cleanup.

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

## Injury refresh

`sync-player-injuries` refreshes injuries each quarter hour on game days, from 11:00 ET through the last scheduled tipoff.
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

The `nba-sync-projections` cron job checks due work every fifteen minutes through `invoke_projection_sync_if_due`.
All projection windows use `America/Los_Angeles`, including daylight saving changes.

| Source | Due work |
| --- | --- |
| Sleeper weekly snapshot | Monday 00:00 PT for that Monday–Sunday week, when the season calendar contains that week |
| Sleeper game-day refresh | 08:00, 12:00, and 15:00 PT while that day's first regular-season tipoff remains in the future |
| FantasyPros backup | 08:00 and 15:00 PT |

Late checks claim the current week and latest elapsed daily window.
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

## Dispatch and invocation records

Daily jobs check due work every fifteen minutes.
Ranking jobs check hourly and catch up within their ISO week.
A successful dispatch claim suppresses duplicate work.
Failed claims can retry after five minutes, with three attempts per period.

Each invocation records its request ID and worker outcome.
The five-minute reconciler joins these records with transport results.
A finished worker result determines success or failure.
A transport timeout alone does not override a successful worker.
Correlated work fails after ten minutes without a start or finish.
Legacy uncorrelated requests retain their two-hour response window.
Normal overdue detection takes ten to fifteen minutes, excluding scheduler delays.

Idle gates protect nominations, stats dispatch, live polling, lineups, and trades.
The trade gate checks expirations, accepted trades, and queued notification delivery.
Idle ticks create no Edge invocation rows.
Cron still records SQL executions when cluster logging is enabled.
Missing Edge credentials surface when work becomes due.

Stats range workers process at most one provider game per invocation.
Empty-date scans checkpoint after each 31-date batch.
They release after four batches or the one-second scan budget, which can overrun by one batch.
A failed checkpoint stops further work.

Live polling targets twenty-second ingestion intervals.
Each tick budgets eighteen seconds; each worker budgets 110 seconds.
An abort guard stops work at 115 seconds.
A ninety-second lease renews every thirty seconds. Lease loss stops further writes.
One scoring pass follows each batch of game updates.
Missing final-game stats remain eligible for recovery.
Failed provider requests back off without marking the game complete.
A final NBA CDN box score with valid team scores also saves them and its status text as the game's Final scoreboard sample.
Later non-final scoreboard samples cannot overwrite that final score.

Response-table maintenance uses ordinary vacuum to reclaim expired response space.
It preserves live responses and requires no table rewrite.
Review table size, dead tuples, and reconciliation time before changing its frequency.

## Weekly cleanup

Cron job `retention-prune` calls `prune_unbounded_history` every Sunday at 10:00 UTC.
It covers all job and function names, including deleted cron jobs.

| Records | Success retention | Failure retention | Protected records |
| --- | --- | --- | --- |
| `sync_runs` | Seven days after finish | Thirty days after finish | Newest finished success and failure per function; unfinished runs |
| `edge_invocations` | Seven days after reconciliation | Thirty days after reconciliation | Newest terminal success and failure per function; running or unreconciled invocations |
| `cron.job_run_details` | Seven days after end or start | Thirty days after end or start | Nonterminal statuses; no newest-outcome exception |

A reconciled failed worker is terminal even when its finish time is absent.
Cron logs do not preserve the newest success or failure after expiry.
League history, NBA stats, games, and news are never deleted by this cleanup.

Projection cleanup uses the current Pacific Monday as its cutoff.
Sleeper game dates before that cutoff expire.
Projection runs and their FantasyPros rows expire when `projection_period_end` precedes the cutoff.
Current and future periods remain.
An index selects expired periods without scanning source rows.
The transaction suppresses projection deletion hints and restores the prior cleanup flag before returning.
Visible new projections still emit resource hints.

### Cleanup bounds

| Operation | Limit per call |
| --- | --- |
| Sync and invocation logs | Batches of 500 unlocked rows; 20,000 rows per table and outcome |
| Cron logs | Scan 200,000 records in primary-key pages of 1,000 |
| Sleeper projections | 10,000 unlocked rows |
| Projection runs | Up to 200 run locks |
| FantasyPros child rows | Batches of 500; 10,000 rows during weekly cleanup or 100,000 during successful-run compaction |

Health indexes locate the newest outcome per function.
Cron cleanup uses its existing primary index because managed Supabase owns that table.
Run deletion waits until child rows are gone, so cascades cannot bypass the row budget.
Locked rows wait for a later call. Large backlogs can need additional calls.
Results count actual deletions per table.
Deletes free reusable space; they do not immediately shrink relation files.

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
The C237 single-source release hold remains in `espn_release`; the separate two-source cycle establishes sustained absence.
Clearing a stale team preserves IDs, stats, ownership, and the existing unassigned-player list.
The team-filtered Players list then excludes that row.

Injuries refresh every 15 minutes from 11:00 ET through the last tip-off on game days.
Outside that window, they refresh hourly from 08:00 through 02:00 ET, including days without games.
The existing claim, retry, dispatch, and empty-body contract stay unchanged.
Run `supabase/sql/player-data-audit.sql` to inspect missing source fields and pending absence holds.
