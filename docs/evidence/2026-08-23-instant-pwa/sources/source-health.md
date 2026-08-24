# Configured Game Source Health

- Status: PASS
- Generated: 2026-08-23T18:26:49.861Z

| Source | Status | Freshness | Completeness | Failures | Recovery |
| --- | --- | --- | --- | --- | --- |
| nba-cdn | PASS | pass: sync-schedule latest=success, age=0.8h, rows=1225. source:nba-cdn-scoreboard latest=success, age=0.8h, rows=0. sync-stats latest=success, age=0.8h, rows=0. sync-players latest=success, age=0.8h, rows=599. | pass: season=2027, games=1200, weeks=25, finals_missing_stats=0/0, nba_ids=642. | pass: Latest schedule, scoreboard, box-score, and player-index attempts are successful. | pass: Down, non-JSON, reshaped, and next-good NBA CDN requests pass the degraded-source suite. |
| espn-public-json | PASS | pass: sync-players latest=success, age=0.8h, rows=599. | pass: espn_ids=614, news=94, latest_news_age=31.3h. | pass: Latest player, team, position, injury, and news attempt is success; errors are retained in sync_runs. | pass: A live 403 failure was recorded, the endpoint changed, and the next local run succeeded. |
| fantasypros | PASS | pass: 3/3 projection types attempted within 48h. | expected-unavailable: daily=skipped:0 rows, weekly_avg=skipped:0 rows, weekly_total=skipped:0 rows | pass: daily: No FantasyPros daily projection rows parsed from public HTML \| weekly_avg: No FantasyPros weekly_avg projection rows parsed from public HTML \| weekly_total: No FantasyPros weekly_total projection rows parsed from public HTML | pass: Unavailable and changed markup return zero rows; a saved valid response parses on the next attempt. |
| hashtag-basketball | PASS | pass: sync-rankings latest=success, age=0.8h, rows=400. | pass: latest points view has 400 rows; fetched_at=2026-08-23T17:41:16.862Z. | pass: Latest ranking attempt is success; row floors and selected-view checks fail closed. | pass: Changed markup returns zero rows; the saved valid response parses after the degraded case. |
| nba-draft-order | PASS | pass: sync-draft-order latest=success, age=0.8h, rows=192. | pass: 61 rookies have a verified draft number. | pass: Latest draft attempt is success; incomplete boards preserve prior data. | pass: A failed window day preserves prior data; the next valid day writes and verifies all picks. |
| sleeper-fallback | PASS | disabled: No request is expected while the fallback flag is off. | disabled: Dormant data does not count toward the active player-source floor. | disabled: No silent request can occur while the source is disabled. | disabled: Recovery requires an intentional source switch after licensing review. |
