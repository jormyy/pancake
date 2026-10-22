# Source monitoring and recovery

Every enabled source records its latest attempt and result. The health report never omits a configured source.

## Health contract

| Source | Freshness record | Completeness check | Failure record | Recovery |
| --- | --- | --- | --- | --- |
| NBA CDN | Schedule, scoreboard, stats, and player sync runs | Games, weeks, final-game stats, and NBA IDs | `sync_runs` keeps the error | Cron retries the next poll |
| ESPN public JSON | Player sync run and latest news date | ESPN IDs and news rows | Any player, injury, or news error fails the run | Daily sync retries every component |
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
A final NBA CDN box score with valid team scores also saves them and its status text as the game's Final scoreboard sample.
Later non-final scoreboard samples cannot overwrite that final score.

The response-table maintenance job uses ordinary vacuum to reclaim expired response space.
It preserves live responses and requires no table rewrite.
Inspect table size, dead tuples, and reconciliation time when reviewing its frequency.

Successful high-frequency operational records retain seven days under the existing retention policy.
Failures, important daily or weekly results, player stats, game records, and league history remain protected.

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

Sleeper remains dormant. Its data does not count toward active-source health.

## Player sources

`PLAYER_SYNC_SOURCE` defaults to `espn`. Setting it to `sleeper` enables the dormant fallback.
ESPN supplies names, teams, coarse positions, injuries, and news.
The sync preserves finer existing position eligibility.
NBA CDN supplies NBA identities. Existing Sleeper identities remain resolvable.
Truncated master lists fail before replacement.
ESPN roster pages name only signed players. A refresh that lists every NBA team once, each roster nonempty, every athlete identifiable and every record imported,
clears the team of each teamed player it no longer names; the row, IDs, injury, status, ownership and lineups stay, and the next listing that names him sets his new team.
Any listing gap or import failure releases nobody, and the run reports the reasons as `releaseSkipped`.
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
