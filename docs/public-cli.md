# Public Pancake CLI

This guide describes candidate API v2. Production deployment remains pending.

Every non-deleted league is public. The CLI requires no login, share token, or commissioner action.
It reads public league data and performs no mutations.
Use Node 22 or later.

## Install and discover

```sh
npm install -g ./packages/pancake-cli
pancake leagues --query dynasty --json
pancake teams --league "$LEAGUE_ID" --json
pancake rosters --league "$LEAGUE_ID" --team "$TEAM_ID" --json
```

The default is `https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api`.
The [production project record](production-migration-history.md) names this project.
The [app URL resolver](../lib/shared/api-url.ts) defines the `/functions/v1/api` path.
The default points to the production location for this release. API v2 is not deployed by this work.
No configuration is needed after release. The package ships no Supabase key or database credentials.
Set `PANCAKE_API_URL` or pass `--api-url` to override the default. The flag takes precedence.
Use HTTPS except for loopback development URLs.
Get stable league IDs from `leagues` and team IDs from `teams`.
Missing required options and malformed UUID options exit 2 locally, with the lookup command in stderr. They make no network request.
Team IDs identify league memberships. They are not account IDs.

## Commands and public fields

Each command reads `GET /public/v2/<command>`.
Every command except `leagues`, `describe`, and `explain` requires `--league`.
`rosters` also requires `--team`.
All data commands accept `--limit`, `--cursor`, `--sort`, and `--direction asc|desc`.
The default page size is 25. The maximum is 50.
Only the resource's scalar public fields are valid sort keys.

The table is the public item-field inventory. Nested roster player fields match `players`, excluding `leagueId`.
Scoring settings contain only the thirteen scoring weights in the schema.

| Command | Allowed item fields | Additional filters |
| --- | --- | --- |
| `leagues` | `id`, `name`, `status` | `--query` |
| `league` | `id`, `name`, `status`, `leagueId`, `seasonId`, `seasonYear`, `timezone`, `rosterSize`, `irSlots`, `taxiSlots`, `taxiRule`, `taxiMaxSeasons`, `teamLimit`, `auctionBudget`, `waiverMode`, `faabStartingBudget`, `weeklyAddLimit`, `tradeDeadline`, `tradeVetoMode`, `tradeVetoWindowHours`, `tradeVetoThresholdPercent`, `allowInactiveTrades`, `playoffStartWeek`, `playoffEntrants`, `rookieDraftOrder`, `futurePickYears`, `scoringSettings`, `playoffRoundLengths`, `playoffRoundWeeks`, `playoffTotalWeeks`, `lineupSlots`, `waiverOrder` | `--season` |
| `seasons` | `id`, `leagueId`, `seasonYear`, `isCurrent`, `regularSeasonStart`, `regularSeasonEnd` | None |
| `teams` | `id`, `leagueId`, `name` | `--team`, `--query` |
| `players` | `id`, `leagueId`, `name`, `nbaId`, `nbaTeam`, `position`, `injuryStatus`, `yearsExperience`, `status`, `birthdate`, `injuryReason`, `injuryExpectedReturn`, `nbaDraftNumber`, `careerGames`, `headshotUrl`, `eligiblePositions` | `--player`, `--query`, `--position` |
| `free-agents` | `id`, `leagueId`, `name`, `nbaId`, `nbaTeam`, `position`, `injuryStatus`, `yearsExperience`, `status`, `availability`, `waiverClearsAt`, `waiverEligible`, `birthdate`, `injuryReason`, `injuryExpectedReturn`, `nbaDraftNumber`, `careerGames`, `headshotUrl`, `eligiblePositions` | `--player`, `--query`, `--position`, `--season` |
| `rosters` | `id`, `leagueId`, `seasonYear`, `teamId`, `isOnIR`, `isOnTaxi`, `player` | `--team`, `--season` |
| `standings` | `id`, `leagueId`, `name`, `wins`, `losses`, `ties`, `pointsFor`, `pointsAgainst`, `maxPointsFor`, `rank` | `--team` |
| `matchups` | `id`, `leagueId`, `seasonYear`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` | `--team`, `--week`, `--season` |
| `scores` | `id`, `leagueId`, `seasonYear`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` | `--team`, `--week`, `--season` |
| `schedule` | `id`, `leagueId`, `seasonYear`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` | `--team`, `--week`, `--season` |
| `player-stats` | `id`, `leagueId`, `name`, `nbaId`, `nbaTeam`, `position`, `injuryStatus`, `yearsExperience`, `status`, `seasonYear`, `fantasyPoints`, `gamesPlayed`, `points`, `rebounds`, `assists`, `steals`, `blocks`, `turnovers`, `threePointersMade`, `minutes`, `birthdate`, `injuryReason`, `injuryExpectedReturn`, `nbaDraftNumber`, `careerGames`, `headshotUrl`, `eligiblePositions`, `fieldGoalsMade`, `fieldGoalsAttempted`, `freeThrowsMade`, `freeThrowsAttempted`, `doubleDoubles`, `tripleDoubles` | `--player`, `--query`, `--position`, `--season` |
| `projections` | `id`, `leagueId`, `name`, `nbaId`, `nbaTeam`, `position`, `injuryStatus`, `yearsExperience`, `status`, `date`, `source`, `fetchedAt`, `projectionStatus`, `fantasyPoints`, `points`, `rebounds`, `assists`, `steals`, `blocks`, `turnovers`, `minutes`, `birthdate`, `injuryReason`, `injuryExpectedReturn`, `nbaDraftNumber`, `careerGames`, `headshotUrl`, `eligiblePositions` | `--player`, `--query`, `--position` |
| `drafts` | `id`, `leagueId`, `seasonYear`, `draftType`, `status`, `scheduledAt`, `startedAt`, `completedAt` | `--draft`, `--season` |
| `draft-results` | `id`, `leagueId`, `seasonYear`, `draftId`, `draftType`, `overallPick`, `round`, `teamId`, `teamName`, `playerId`, `playerName`, `pickedAt`, `price` | `--draft`, `--team`, `--season` |
| `picks` | `id`, `leagueId`, `seasonYear`, `round`, `teamId`, `originalTeamId`, `isUsed` | `--team`, `--season` |
| `trades` | `id`, `leagueId`, `seasonYear`, `status`, `completedAt`, `proposerTeamId`, `recipientTeamId`, `teamIds` | `--trade`, `--season`, `--team` |
| `trade-assets` | `id`, `leagueId`, `tradeId`, `status`, `completedAt`, `fromTeamId`, `toTeamId`, `kind`, `playerId`, `playerName`, `pickId`, `pickSeasonYear`, `pickRound` | `--trade`, `--team` |
| `transactions` | `id`, `leagueId`, `teamId`, `teamName`, `playerId`, `playerName`, `type`, `occurredAt`, `tradeId` | `--team`, `--season` |

`season` is the season's starting year. `seasons` lists a league's available seasons.
Standings use the current published standings cache. Historical standings are not supported.
`matchups`, `scores`, and `schedule` share one result projection. A week filter includes multiweek matchups spanning that week.
`players` lists canonical player metadata. `player-stats` adds league-scored season averages.
`projections` reads the existing public-data projection calculator. It never reads claims or lineups.
`free-agents` includes all unrostered players, including players on waivers.
`waiverEligible` means a player is unrostered. It does not predict whether a manager's claim will succeed.
`waiverClearsAt` is null when no active hold exists.
Manager budget, roster capacity, existing claims, and reservations never affect those public fields.
The settings `waiverOrder` is the published league order, not the order of private claims.

`drafts` lists non-mock drafts. `draft-results` returns completed draft picks and sold auction results with stable player IDs.
Use `--draft` to page through one draft. `picks` lists current ownership of future draft-pick assets.
`trades` returns only completed trades with a completion timestamp.
Use `trade-assets --trade "$TRADE_ID"` for paginated player, pick, and budget-transfer asset identities.
Budget transfer amounts are omitted, as are all waiver bids.
For multi-team trades, `teamIds` contains the participants. A team filter includes these participants.

Every sort ends with ascending `id` as its final tie-breaker.
`--direction` controls the selected primary key; secondary keys remain ascending.
Offset cursors bind the version, league, resource, filters, limit, and sort.
Continue until `nextCursor` is null. Concurrent public changes can shift pages; restart a scan for a fresh view.
The current safety limit is an offset of 100,000. The API returns an error instead of falsely ending a larger scan.
No count of private records is exposed.

## Database source inventory

All rows pass the selected public league boundary before their resource query runs.
The new function uses explicit projections instead of authenticated screen payloads.
Its exact column expressions and predicates are stored in the policy file and checked against the generated migration.

| Resource | Source query | Record predicate before paging |
| --- | --- | --- |
| `leagues`, `league` | `leagues` and selected `league_seasons`; settings also read `lineup_slot_templates` | `deleted_at IS NULL`; one league for settings |
| `seasons` | `league_seasons` | Selected league |
| `teams` | `league_members` | Selected league; membership ID and team name only |
| `rosters` | `roster_players`, `players`, scoped `league_members` | Selected league and season; public team filter |
| `players` | `players` | Canonical public player directory |
| `free-agents` | `players`, scoped `roster_players`, active `waiver_wire_log` | No ownership in selected league season; hold has no `cleared_at` and a future `clears_at` |
| `standings` | `league_members`, `standings_current` | Selected league and current season cache; published win-rate and points-rate ranking |
| `matchups`, `scores`, `schedule` | `matchups`, scoped home and away `league_members` | Selected league and season; `NOT is_voided` |
| `player-stats` | `players`, `player_season_averages`, `mv_player_season_averages`, `v_player_avg_fantasy_points` | League-specific scoring and selected statistics year |
| `projections` | `players`, narrow `get_league_projection_rows` calculation | Selected league scoring; current date; one canonical player per calculation |
| `drafts` | `drafts` | Selected league and season; `NOT is_mock` |
| `draft-results` | `snake_draft_picks` or sold `nominations`, `drafts`, `players`, scoped `league_members` | Non-mock completed draft; picked snake player or sold auction result |
| `picks` | `draft_picks` | Selected league; optional future season and current owner |
| `trades` | `trades`, scoped `league_seasons`, `trade_participants` | `status='completed' AND completed_at IS NOT NULL` |
| `trade-assets` | `trade_items`, qualifying parent `trades`, scoped `draft_picks`, `players` | Same completed-parent rule; item and parent league agree |
| `transactions` | Public move types from `roster_transactions` plus `trade_completed` from `league_activity` | Selected league and season; trade events require a completed parent before paging |

Underlying tables retain their existing RLS and grants. Anonymous callers receive no new table or RPC privileges.
Only the Edge service role gains execute permission on `public_read_v2`.
The definer function's predicates enforce its boundary; it does not rely on underlying RLS to filter its own queries.
The internal rate table has RLS enabled and no client grants.

Completed auction sale prices are public draft results. Open auction bids and waiver bids are not returned.

## Agent examples and schemas

```sh
pancake describe
pancake describe free-agents
pancake explain trades.completedAt
pancake player-stats --league "$LEAGUE_ID" --query Jokic --sort fantasyPoints --direction desc
pancake free-agents --league "$LEAGUE_ID" --position C --limit 50
pancake trades --league "$LEAGUE_ID" --team "$TEAM_ID"
pancake trade-assets --league "$LEAGUE_ID" --trade "$TRADE_ID"
```

`describe` and `explain` work offline. They list field schemas, commands, valid options, and exit codes.
JSON is the default for redirected stdout. Use `--json` or `--text` to select a format.
Only data goes to stdout. Errors go to stderr.

```json
{
  "$schema": "urn:pancake:public:v2:teams",
  "version": 2,
  "resource": "teams",
  "items": [],
  "nextCursor": null
}
```

The package includes `schemas/v2.json`. Version two changes the access scope from one capability token to an explicit public league ID.
Version one routes return HTTP 410. Version one schema files remain available as historical contracts.
A script can pass each response's `nextCursor` to the same command and options.
Stop on errors. Do not infer private claims or pending trades from public data.

## Privacy boundary

[The policy file](../supabase/functions/api/public/policy.json) declares the public fields, source queries, record rules, filters, and default order.
[The generator](../tools/verify/public-policy.mjs) builds both response schemas and the [current SQL migration](../supabase/migrations/20261214010600_public_sort_ties.sql).
The generator applies record predicates and an explicit field projection before public filters, ordering, page bounds, and `hasMore`.
The Edge handler repeats the field projection before serialization and rejects invalid shapes.
The database function is security definer with an empty search path. Only the Edge service role can execute it.
It does not impersonate a member or call authenticated screen functions.

Excluded data includes account IDs, email addresses, profiles, invite codes, notifications, messages, commissioner-only fields, claims, bids, and lineup assignments.
The API also excludes offers, negotiations, trade notes, veto votes, estimates, and accepted trades awaiting execution.
Only `completed` trades with non-null `completed_at` pass the trade predicate.
The [trade execution code](../supabase/migrations/20261214010000_trade_rule_error_transport.sql) moves assets before recording that state.
Acceptance clears `completed_at` and can wait for a veto window or roster constraint.

The [waiver policy](../supabase/migrations/20260627000018_waiver_claim_privacy.sql) hides expired uncleared holds.
The new projection also requires `cleared_at IS NULL AND clears_at > now()` for public waiver clear times.
The [team timeline](../supabase/migrations/20261106000200_timeline_producers.sql) removes bid amounts from other members' displayed details.
No pending or historical claim bid is published here.

The old `public_share_token` RPC and storage remain for compatibility with existing database callers.
The new API never reads those tokens or their rate counters. Their creation and revocation do not affect public access.
The old token reader remains restricted to the service role and has no active public route.
The public package no longer includes `db-health`. The separate operator tooling under `scripts/db-health` remains unchanged.

## Public string bounds

The database accepts unbounded text for league and player names, external player IDs, injury text, URLs, and other provider text.
The public projection returns at most 1,024 Unicode code points from those values.
It also limits each eligible-position string to 32 code points.
These prefixes are applied in SQL before public search, sorting, counts, and pagination.
The Edge serializer applies the same rule as a backstop. Stored values are unchanged.

Public UUIDs retain all 36 characters. Date and timestamp strings allow 64 characters.
Team names retain their database limit of 40 characters. Database enums and checked fields use their actual maximum label lengths.
Nested strings follow the same rules as top-level fields. Bounded arrays retain their first declared maximum number of items.
The schema marks lossy text or array projections with `x-overflow: truncate`.

A page can contain fewer items than the requested limit when its JSON would exceed two MiB.
Follow its cursor without changing the original request options. The cursor advances by the number of returned records.
A large accepted text value cannot hide the other records on its page.

## Limits, errors, and caching

The server admits at most 60 reads per client-IP bucket per minute across Edge instances.
Admission is a separate `public_admit_read` RPC. Its short transaction commits before `public_read_v2` begins.
The read transaction never updates rate counters or holds their row locks.
There is no application-wide quota that one client can exhaust for every user.
The local limiter retains at most 4,096 client buckets. Database admission remains authoritative after local eviction.
Expired database buckets are removed in indexed, bounded batches.

Only `CF-Connecting-IP` supplies the client identity. `X-Forwarded-For` and `X-Real-IP` are ignored.
[Supabase documents that its platform sets this header on every request](https://supabase.com/docs/guides/api/query-plans#production-use-with-pre-request-protection).
[Its Edge log reference also lists the header](https://supabase.com/docs/guides/observability/log-field-reference).
This trust applies to Supabase's managed ingress, not an arbitrary self-hosted proxy.
[Cloudflare documents Worker and proxy limitations](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip).
A self-hosted deployment must overwrite this header at its trusted ingress before using this policy.
Missing, duplicate, or malformed header values share one `unattributed` bucket. No alternate client header is trusted.
IPv4 and IPv6 representations are normalized before hashing. No raw IP address is stored by this counter.

Per-IP limits do not stop distributed attacks, prevent shared-NAT contention, or impose a total database-cost ceiling.
Platform capacity controls still apply. No claim of complete denial-of-service protection is made.

HTTP 429 includes `Retry-After`. The CLI does not retry 429 or invalid requests.
It retries network failures and HTTP 502, 503, or 504 at most twice with short exponential backoff.
All attempts share a 15-second timeout. Redirects are rejected.
Response bodies and stdout are capped at two MiB. Individual fields and lists have schema bounds.

Responses have ETags and require revalidation. Conditional requests still enforce resource access and rate limits.
The CLI caches at most 128 files keyed by URL, without tokens. It never returns stale cache data after an error.
Use `--no-cache` or `--cache-dir` when needed.
The Edge API rejects missing or malformed required IDs with a fixed 400 response before any database call.
The SQL reader also returns a fixed 400 for malformed parameter values instead of exception text.
Valid unknown and cross-league object IDs use the same 404 response shape.
A private trade ID and a nonexistent trade ID also share the same 404 response.
Invalid options use 400; unexpected database failures use a fixed 503 response without database details.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Missing or invalid option, malformed UUID, or invalid request |
| 4 | Syntactically valid but unavailable public resource |
| 5 | Rate limit |
| 6 | Network failure or timeout |
| 7 | Server failure, invalid schema, or output limit |

## Verification and proof scope

```sh
node tools/verify/public-policy.mjs --check
node tools/verify/public-model.mjs
npx vitest run tests/public-cli
node --test tests/e2e/public-cli-v2.mjs
node --test tools/perf/public-cli.test.mjs
deno test supabase/functions/api/public/handler.test.ts supabase/functions/api/public/reader.test.ts
```

The model exhaustively checks the bounded trade-state and completion-state combinations, filter/page cases, and 128 private-field subsets per case.
It compares observable rows, search results, ordering, `hasMore`, and page slices with the private data absent.
The tests also inject random private fields into every resource's serialization path.
The packed-package test installs the actual executable under a temporary prefix and calls every command against a local stub server.

The model assumes source tables and joins match the generated policy, fixed public snapshots, and a fixed request history.
It does not prove timing independence, database execution, source-data correctness, concurrency, or availability under attack.
A database failure can still reflect shared resource pressure. No stronger side-channel guarantee is claimed.
Free-agent property cases vary pending claims, bids, counts, and claim order while comparing availability, search, sorting, and cursors.
The projection reads only public roster ownership and active waiver holds; it never reads claim or bid tables.
The real database noninterference test is [public-cli-v2.sql](../tests/db/public-cli-v2.sql).
Both it and the [catalog verification](../tests/db/public-cli-v2-verify.sql) pass on a fresh isolated stack.
The rollback chain, reapplication, real installed commands, and concurrent admission pass on that stack.
Additional two-league fixture checks compare complete responses and cursors before and after private records are added.

## Public CLI release order

Follow [RELEASE-DB.md](../supabase/RELEASE-DB.md). This change does not apply migrations or deploy to production.
Apply `20261214010300_public_league_reads.sql`, `20261214010400_public_read_admission.sql`, `20261214010500_public_projection_bounds.sql`, then `20261214010600_public_sort_ties.sql` on the isolated stack first.
The second migration separates admission, removes the global quota, and validates values before SQL casts.
Run the catalog query and database tests. Regenerate database types and the database function catalog from that tested stack.
The canonical SQL source check must also pass before release.
After approval, apply the database migration before deploying the Edge API and installing version two of the CLI.
Old version-one clients receive an explicit version-retired response.

If verification fails, restore the matching previous Edge artifact.
[Rollback 106](../supabase/rollbacks/20261214010600_public_sort_ties.sql) restores the previous sort behavior.
[Rollback 105](../supabase/rollbacks/20261214010500_public_projection_bounds.sql) restores the earlier public reader without changing stored data.
[Rollback 104](../supabase/rollbacks/20261214010400_public_read_admission.sql) restores the earlier reader and removes separate admission.
[Rollback 103](../supabase/rollbacks/20261214010300_public_league_reads.sql) then removes the feature reader and counters if required.
These rollbacks preserve the existing sharing functions and league data.
Confirm the previous version-one routes with a local fixture capability after recovery.
Do not claim a rollout until a real stack passes the catalog, privacy, and installed-CLI checks.

## Local performance evidence

These historical measurements use candidate `8274e012`, before the public-text and sort repairs.

These are fixture/local-stack measurements on one Mac mini, not live production results.
The baseline uses commit ce1c1c2e and a local fixture share token; version two uses no token.
Both versions use the same router transport, PostgreSQL settings and seeded rows.
The Edge router runs under host Deno because the task directory is outside the existing VM's allowed mounts.
This does not verify the deployed Supabase Edge runtime.

The fixture contains 30 leagues, 360 teams, 600 players, 5,400 roster rows, 1,200 trades, 3,600 claims and 49,200 game-stat rows.
Both runs use fixture date 2026-11-07 and fully primed derived caches.
Each case has two warmups and 30 measured requests, spaced by at least 1.12 seconds.
The harness traverses the cursor chain before selecting first, middle and last pages.
Statement counts include nested and outer database statements with pg_stat_statements.track=all.
The table reports median statement deltas and response sizes; latency columns show p50 and p95.
Whole-database counters include occasional local Realtime polling. Candidate deltas range from 15 to 17; baseline deltas range from 31 to 174 across the listed resources. These are observed deltas, not individually attributed statement traces.

| Resource and page | v1 p50 / p95 ms | v2 p50 / p95 ms | Statements p50 | KiB p50 |
| --- | ---: | ---: | ---: | ---: |
| league 1/1 | 12.3 / 13.7 | 15.9 / 17.8 | 31 → 15 | 0.5 → 2.1 |
| rosters 1/3 | 18.9 / 20.4 | 17.8 / 20.2 | 77 → 15 | 1.4 → 2.8 |
| rosters 2/3 | 19.0 / 19.8 | 18.4 / 25.9 | 77 → 15 | 1.4 → 2.8 |
| rosters 3/3 | 18.6 / 21.3 | 18.0 / 20.3 | 77 → 15 | 1.3 → 2.7 |
| player-stats 1/24 | 57.3 / 61.3 | 39.9 / 42.5 | 173 → 15 | 6.4 → 17.2 |
| player-stats 12/24 | 57.2 / 59.5 | 39.8 / 43.7 | 173 → 15 | 6.4 → 17.3 |
| player-stats 24/24 | 58.2 / 62.0 | 39.9 / 43.2 | 173 → 15 | 6.4 → 17.3 |

Version one emits an additional empty page after the last player-stat data page.
The table compares matching nonempty pages; version two ends at the last data page.
The public-read contract and payload fields differ between versions, so these are release comparisons rather than identical-query microbenchmarks.
League latency rises while its payload grows about fourfold and admission adds an RPC. This experiment does not isolate their individual effects.
The middle roster page has a higher p95 despite a lower median; thirty samples do not establish tail stability.
Raw per-request measurements, database statement samples and environment details accompany the review evidence.
The repository harness is tools/perf/public-cli.mjs; its eight focused tests check measurement behavior.
No production speedup or deployment is claimed.
