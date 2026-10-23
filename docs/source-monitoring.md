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
A box player whom no NBA id or name joins links to an existing ESPN row only when the box lists him under its side and ESPN lists exactly one row on that side with the same name words in any order, has listed it there since before tip-off and on no other team since, that row has no NBA id, and no other player on that side has those words; a CDN-only row an earlier box made for his NBA id then merges into it.
No jersey, nickname, prefix or spelling distance is used.
Truncated master lists fail before replacement.
ESPN roster pages name only signed players, but a page can answer 200 and still omit one.
A structurally complete refresh (every NBA team once, each roster nonempty, every athlete identifiable, every record imported) is therefore not proof that anyone left.
Stored NBA boxes are not proof either: real boxes omit signed players for a game or for months, whether their last listing showed them playing, inactive or not at all.
No feed the product reads states, with a date, that a player is no longer rostered.
An omitted player's team changes (`released`) only when his latest stored box since he was last placed on that team is of a regular-season or postseason game his team did not play.
He was last placed there by ESPN's latest listing of him on that team or his latest stored regular-season or postseason box under it, whichever is later, so a second move proven only by boxes is released too.
He moves to the side that box lists him under, so he stays startable on its game days; without a stored side his team is cleared.
Every path that stores a box (sync-stats, the live poll and both CDN backfills) records its sides before the box's own import.
A merge of two player rows keeps each stored side and the later of their ESPN listings.
The next listing names his team either way.
Otherwise a team changes only when an ESPN listing names him on another team; his row, IDs, injury, status, ownership and lineups stay either way.
Every other omitted teamed player keeps his team and is counted in `releaseHeld` (`unproven`, or `unclaimed` for rows ESPN never claimed).
The NBA index step runs between the ESPN import and the sweep, so a person whose split rows it merges is read as one row with his listing and his boxes.
Any listing gap, import failure or NBA index failure skips the sweep, and the run reports the reasons as `releaseSkipped`.
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
