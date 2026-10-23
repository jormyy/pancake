# Source monitoring and recovery

Every enabled source records its latest attempt and result. The health report never omits a configured source.

## Health contract

| Source | Freshness record | Completeness check | Failure record | Recovery |
| --- | --- | --- | --- | --- |
| NBA CDN | Schedule, scoreboard, stats, and player sync runs | Games, weeks, final-game stats, and NBA IDs | `sync_runs` keeps the error | Cron retries the next poll |
| ESPN public JSON | Player sync run and latest news date | ESPN IDs and news rows | Any player, injury, or news error fails the run | Daily sync retries every component |
| Sleeper (RotoWire) | Current-week successful run within eight days | At least 300 matched players in season | Strict shape checks record failed runs | Last good player-game rows stay available |
| FantasyPros | One run per projection type | Rows and player matches | Failed or skipped runs keep the reason | Internal averages remain available |
| Hashtag Basketball | Ranking sync run and fetch date | A view must meet its row floor | Changed views fail before replacement | The next weekly run retries |
| NBA draft order | Draft sync run | At least 50 verified picks | Incomplete boards keep prior data | Each window day retries |
| Sleeper | Disabled | Disabled | No request occurs | Explicit fallback setting |

Run the degraded-source tests before the report. Then confirm that proof for the report run.

```sh
deno test --allow-env --allow-net --allow-read \
  supabase/functions/_shared/nbaCdnDegraded.test.ts \
  supabase/functions/_shared/playerSource.test.ts \
  supabase/functions/sync-projections/parser.test.ts \
  supabase/functions/sync-rankings/parser.test.ts \
  supabase/functions/sync-draft-order/degraded.test.ts
E2E_SOURCE_RECOVERY_VERIFIED=1 npm run e2e:source-health
```

## Cron dispatch and invocation records

Daily jobs check due work every 15 minutes. Ranking jobs check hourly and catch up within their ISO week.
A successful dispatch claim suppresses duplicate work. Failed claims can retry after five minutes, with three attempts per period.

Each invocation records its request ID and worker outcome. The five-minute reconciler joins these records with transport results.
A finished worker result determines success or failure. A transport timeout alone does not override a successful worker.
Correlated work fails after ten minutes without a start or finish. Legacy uncorrelated requests retain their two-hour response window.
A five-minute reconciliation interval gives overdue work a normal detection window of ten to fifteen minutes, excluding scheduler delays.

Idle gates protect nominations, stats dispatch, live polling, lineups, and trades.
The trade gate checks expirations, accepted trades, notification delivery, and pending receipts.
Idle ticks create no Edge invocation rows. Cron still records its SQL executions when cluster logging is enabled.
Missing Edge credentials surface when work becomes due.

Stats range workers process at most one provider game per invocation.
They checkpoint empty-date scans after each 31-date batch and release after four batches or the scan budget.
The one-second scan budget can overrun by one batch. A failed checkpoint stops further work.

Live polling targets twenty-second ingestion intervals. Each tick budgets eighteen seconds; each worker budgets 110 seconds.
An abort guard stops work at 115 seconds. A ninety-second lease renews every thirty seconds.
Lease loss stops further writes. One scoring pass follows each batch of game updates.
Missing final-game stats remain eligible for recovery. Failed provider requests back off without marking the game complete.

The response-table maintenance job uses ordinary vacuum to reclaim expired response space.
It preserves live responses and requires no table rewrite.
Inspect table size, dead tuples, and reconciliation time when reviewing its frequency.

Weekly cleanup covers every cron job and function name, including deleted cron jobs.
Successful records expire after seven days. Failed records expire after thirty days.
Each function keeps its newest success and failure, even when both are older.
Unreconciled and unfinished invocations remain protected.
League history, NBA stats, games, and news remain unchanged.

## External failure alerts

Failed worker results and reconciliation failures remain queryable in `sync_runs` and `edge_invocations`.
Notification failures retain their retry and dead-letter state.
These records provide diagnostic evidence; they do not establish an external alert destination.
The owner selects the destination, provisions its delivery credentials, and authorizes the delivery integration.
No email address, webhook, or messaging destination is inferred.

## Recovery steps

1. Read the newest failed run and its stored error. For `cron:` rows, compare the worker outcome and transport result.
2. Confirm the upstream shape with a read-only request.
3. Fix the parser, endpoint, or credentials in development.
4. Run the degraded test and one healthy local sync.
5. Confirm a newer successful run and complete row counts.

Do not clear healthy stored data during an outage. Skips and failures preserve the last good rows.

## Known limits

FantasyPros can publish no projections during the offseason. The report marks an explicit zero-row skip as expected then.

The scoreboard can return zero games. A successful empty response differs from a failed request.

Sleeper projections are active. The separate Sleeper player import remains a dormant fallback.

## Player sources

`PLAYER_SYNC_SOURCE` defaults to `espn`. Setting it to `sleeper` enables the dormant fallback.
ESPN supplies names, teams, coarse positions, injuries, and news.
The sync preserves finer existing position eligibility.
NBA CDN supplies NBA identities. Existing Sleeper identities remain resolvable.
Truncated master lists fail before replacement.
Rookie eligibility uses zero experience; career-game taxi eligibility follows the [roster rules](roster-lifecycle.md).

`npm run parity:players` compares the two public feeds.
It writes ignored results under the player-source-parity artifact directory in tests.
It does not edit tracked documentation.

## Participation corrections

The CDN writer honors explicit provider played flags before the minutes fallback.
Zero means DNP. One means played, including zero minutes.
Missing or invalid flags use parsed minutes; missing or malformed minutes indicate DNP.
Raw stat fields remain stored. Scoring applies the DNP exclusion.
Eligible syncs can correct existing rows. Completed backfill jobs do not automatically replay.
Derived averages follow their own refresh schedule.

## Projection refresh and storage

Sleeper supplies RotoWire per-game lines from its public NBA projection endpoint.
Pancake season 2027 maps to Sleeper season 2026.
The first season week starts with the first regular-season game and ends Sunday.
Later weeks run Monday through Sunday.

The due-work gate checks every fifteen minutes.
It claims each Pacific week from Monday at 00:00, including a late first deployment.
Game-day refreshes run at 08:00, 12:00, and 15:00 Pacific before the first tipoff, even when Monday fails.
A late check catches the latest elapsed window. Pacific dates handle daylight saving changes.
The existing dispatch reconciler retries failed claims, with its existing three-attempt limit.
FantasyPros refreshes at 08:00 and 15:00 Pacific.

Sleeper stores one row per matched player and source game.
A pull updates that row only when its source revision is at least as new.
Player matching uses Sleeper IDs first, then a unique normalized name and team when the player lacks an ID.
Runs record parsed, matched, and unmatched counts. Metadata includes input and rejected row counts.
Up to thirty unmatched identities aid diagnosis.
Missing stats become zero. Projected sits store zero lines and suppress backup projections.
Rounding raises attempts to makes. Unused stats do not affect validation.
Malformed rows are skipped and counted in run metadata. More than 20% rejected rows fails the pull.
Invalid bodies, zero valid rows, and failed HTTP responses preserve the last good rows.
All writes from a valid pull commit together.
Recorded fixtures retain both complete public weeks fetched on 2026-10-23.
Tests make no live provider requests.

Readers prefer Sleeper for each game, including the player screen's next game.
Weekly totals sum game lines. Weekly averages divide by the number of covered games.
Missing games use FantasyPros, then the existing internal and season-average fallbacks.
FantasyPros totals divide by their reported game count before filling a missing game.
A mixed week's source label names Sleeper. Its missing games can include backup values.
Sleeper makes and attempts use the existing league scoring function.
Sleeper percentages use total makes divided by total attempts, multiplied by 100.
Mixed percentages weight the available provider percentages by game count because FantasyPros omits attempts.
Failed backup pulls preserve the newest successful FantasyPros run.
A new successful backup pull removes superseded runs and rows within the cleanup budget.

## Cleanup bounds

The existing Sunday 10:00 UTC retention job removes projections from completed weeks.
It retains current and future weeks. FantasyPros dates before the current Pacific Monday expire.
Each run stores its period end when its scope changes. An index selects expired periods without scanning source rows.
The cleanup flag suppresses projection deletion hints within the transaction.
It restores the previous flag before returning. Visible new projections still send resource hints.
The optimizer fingerprint includes effective scored inputs and omits fetch timestamps.
Unchanged pulls and hidden-history cleanup therefore do not trigger another optimizer pass.

Each log deletion selects at most 500 unlocked rows through a retention index.
Each outcome deletes at most 20,000 sync rows and 20,000 invocation rows per call.
Health indexes find the newest outcome for each function.
Cron cleanup scans at most 200,000 records in primary-key pages of 1,000.
It uses the existing primary index because managed Supabase owns the cron table.
Projection cleanup selects at most 10,000 Sleeper rows and 200 run locks per call.
FantasyPros row deletions use batches of 500.
Weekly cleanup deletes at most 10,000 child rows. Successful-run compaction allows 100,000 to clear the initial hourly backlog.
Run deletion waits until its child rows are gone, so cascades cannot bypass that budget.
Locked rows remain for a later call. A large existing backlog can need additional calls.
Counts in the result include only actual deletions from each table.
Deletes free reusable database space; they do not shrink relation files immediately.
