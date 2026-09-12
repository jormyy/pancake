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
| Sleeper | Disabled | Disabled | No request occurs | Enable only after a licensing review |

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

- ET-time gates (`invoke_edge_function_at_et_time`, the weekly ranking sync, the daily
  season boundary) are due from their target time onward and dispatch once per ET day
  (ISO week for the ranking sync), recorded in `cron_dispatch_state`. A tick that runs
  late is caught up by the next tick in the same period; nothing double-dispatches.
- Every `invoke_edge_function` call records its pg_net request id in
  `edge_invocations`. `private.reconcile_edge_invocations()` (cron, every 5 minutes)
  copies the response onto that row and writes a failed `sync_runs` row named
  `cron:<function>` for a transport error, a non-2xx status, or no response within
  2 hours. A function that never booted is therefore visible in `sync_runs`.
- Live-poll also wakes for a Final game on yesterday/today that has no box score, so
  a poll outage that spans a game's end is recovered on the next tick.
- The live-poll lease is renewed every 30 s by the running poll; a poll that loses its
  lease logs `lease lost mid-run`.

## Recovery steps

1. Read the newest failed run and its stored error.
2. Confirm the upstream shape with a read-only request.
3. Fix the parser, endpoint, or credentials in development.
4. Run the degraded test and one healthy local sync.
5. Confirm a newer successful run and complete row counts.

Do not clear healthy stored data during an outage. Skips and failures preserve the last good rows.

## Known limits

FantasyPros can publish no projections during the offseason. The report marks an explicit zero-row skip as expected then.

The scoreboard can return zero games. A successful empty response differs from a failed request.

Sleeper remains dormant. Its data does not count toward active-source health.
