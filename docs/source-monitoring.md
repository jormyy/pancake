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
