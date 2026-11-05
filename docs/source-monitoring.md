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

## Identity matching

Name matches alone cannot join established NBA identities.
Prelink uses a unique NBA owner and corroborated ESPN roster identity on the same team.
A missing-team Sleeper row merges only when it is the sole compatible counterpart.
Provider IDs, known birthdates, and known experience must agree.
A third candidate or conflicting provider ID blocks the merge.
The canonical row keeps its NBA ID; the merge moves references and history.
Reviewed exceptions live in `supabase/functions/_shared/playerIdentityCorrections.md`.

## Player metadata

The player sync uses ESPN roster data.
It reads `dateOfBirth` as a calendar date and stores `birthdate`.
Player views calculate age on the current Los Angeles calendar date.
Age appears before experience in shared player rows.
Views include birthdates where available.
The shared age hook batches missing birthdate reads by player or NBA ID.
Account changes clear that fallback cache and reject late results.
Missing birthdates produce a null age.
Invalid and future birthdates never replace a saved birthdate.

The injury sync reads ESPN `details.type`, `side`, `detail`, and `returnDate`.
It stores a short injury reason and the provider's expected return value.
Missing details use `unknown`.
The return value remains a provider estimate, not a guaranteed return date.
A successful report refreshes details even when the injury status stays the same.
An unavailable or malformed report leaves saved injuries unchanged.

## Experience audit

The audit reads ten players from three ESPN rosters on 2026-10-27.
The source season is 2026–27, with ending year 2027.
ESPN's experience includes the current season for returning players.
The app stores completed seasons, with zero for rookies.
The old direct mapping is one too high for returning players.
The fixed mapping subtracts one from positive ESPN experience and preserves zero.
Debut-year fallback uses season ending year minus debut year minus one.
The dormant Sleeper source keeps its own completed-season value.

| Player | ESPN experience | Completed seasons |
| --- | ---: | ---: |
| Nickeil Alexander-Walker | 8 | 7 |
| Dyson Daniels | 5 | 4 |
| RayJ Dennis | 3 | 2 |
| Luguentz Dort | 8 | 7 |
| Devin Carter | 3 | 2 |
| Chris Cenac Jr. | 0 | 0 |
| Mike Conley | 20 | 19 |
| Cameron Carr | 0 | 0 |
| Luka Doncic | 9 | 8 |
| Quentin Grimes | 6 | 5 |

Sources: [ESPN roster 1](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/1/roster), [ESPN roster 2](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/2/roster), [ESPN roster 3](https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/teams/13/roster).
The reduced source sample lives beside the sync tests as `experience-fixtures.json`.

## Roster identity checks

An ESPN or Sleeper ID must agree with its stored owner's normalized name.
A conflicting name returns an ambiguous result and changes no player data.
An ambiguous import fails the sync and blocks roster cleanup.
The ESPN listing refuses repeated athlete IDs across roster pages before any import starts.
A verified identity can change teams without changing its player ID.

Fresh ESPN listings repair missing or impossible game-team memberships within the known listing period.
A valid historical game side stays unchanged after a trade.
The repair migration also uses a newer stored listing to correct an older player team.

The identity regression uses a synthetic traded player and source-ID collision.
It checks stored identity and listing evidence without hardcoding a real player’s team.
