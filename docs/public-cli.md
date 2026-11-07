# Public Pancake CLI

This guide describes candidate API v2. Database execution and deployment remain pending.

Every non-deleted league is public. The CLI requires no login, share token, or commissioner action.
It reads public league data and performs no mutations.
Use Node 22 or later.

## Install and discover

```sh
npm install -g ./packages/pancake-cli
export PANCAKE_API_URL=https://your-project.supabase.co/functions/v1/api
pancake leagues --query dynasty --json
pancake teams --league "$LEAGUE_ID" --json
pancake rosters --league "$LEAGUE_ID" --team "$TEAM_ID" --json
```

The API URL identifies the deployed Edge API. The package ships no Supabase key or database credentials.
The CLI has no default hosted endpoint. Use HTTPS except for loopback development URLs.
Get stable league IDs from `leagues` and team IDs from `teams`.
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

Results use stable ID tie-breakers. Offset cursors bind the version, league, resource, filters, limit, and sort.
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
[The generator](../tools/verify/public-policy.mjs) builds both response schemas and the [SQL migration](../supabase/migrations/20261214010300_public_league_reads.sql).
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

## Limits, errors, and caching

The server enforces at most 60 reads per client bucket and 600 reads globally per minute.
A database counter enforces the global limit across Edge instances.
The Edge handler also rejects bursts before the database call.
Client buckets use a hash of the forwarded address and a database minute bucket. Missing addresses share one bucket.
Forwarded addresses are best-effort client identity; the global ceiling does not depend on their trustworthiness.
The database stores no raw IP address. Expired buckets are deleted in bounded batches.
These operational counters never appear in public responses.

HTTP 429 includes `Retry-After`. The CLI does not retry 429 or invalid requests.
It retries network failures and HTTP 502, 503, or 504 at most twice with short exponential backoff.
All attempts share a 15-second timeout. Redirects are rejected.
Response bodies and stdout are capped at two MiB. Individual fields and lists have schema bounds.

Responses have ETags and require revalidation. Conditional requests still enforce resource access and rate limits.
The CLI caches at most 128 files keyed by URL, without tokens. It never returns stale cache data after an error.
Use `--no-cache` or `--cache-dir` when needed.
Missing, malformed, unknown, and cross-league object IDs use the same 404 response shape.
A private trade ID and a nonexistent trade ID also share the same 404 response.
Invalid options use 400; unexpected database failures use a fixed 503 response without database details.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid command, option, or request |
| 4 | Missing, malformed, or unavailable public resource |
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
deno test supabase/functions/api/public/handler.test.ts
```

The model exhaustively checks the bounded trade-state and completion-state combinations, filter/page cases, and 128 private-field subsets per case.
It compares observable rows, search results, ordering, `hasMore`, and page slices with the private data absent.
The tests also inject random private fields into every resource's serialization path.
The packed-package test installs the actual executable under a temporary prefix and calls every command against a local stub server.

The model assumes source tables and joins match the generated policy, fixed public snapshots, and a fixed request history.
It does not prove timing independence, database execution, source-data correctness, concurrency, or availability under attack.
A database failure can still reflect shared resource pressure. No stronger side-channel guarantee is claimed.
The real database noninterference test is [public-cli-v2.sql](../tests/db/public-cli-v2.sql).
It and the [catalog verification](../tests/db/public-cli-v2-verify.sql) remain unexecuted until the isolated stack is available.

## Database release and recovery

Follow [RELEASE-DB.md](../supabase/RELEASE-DB.md). This change does not apply migrations or deploy to production.
Apply the new migration in a transaction on the isolated stack first.
Run the catalog query and database tests. Regenerate database types and the database function catalog from that tested stack.
The canonical SQL source check must also pass before release.
After approval, apply the database migration before deploying the Edge API and installing version two of the CLI.
Old version-one clients receive an explicit version-retired response.

If verification fails, restore the previous Edge artifact and run [the matching rollback](../supabase/rollbacks/20261214010300_public_league_reads.sql).
The rollback removes only the new reader and counters. It retains existing sharing functions and data.
Confirm the previous version-one routes with a local fixture capability after recovery.
Do not claim a rollout until a real stack passes the catalog, privacy, and installed-CLI checks.

## Performance evidence still required

The baseline moves to a separate isolated copy of base commit `ce1c1c2e`.
Measure baseline and final responses on mini with the same seeded public data, page sizes, cases, and sample counts.
Use at least 30 samples after warmup. Record p50, p95, statement counts, bytes, and per-page cost.
The harness is `tools/perf/public-cli.mjs`; its seven focused tests validate measurement logic, not API speed.
The original version-one harness needs a local fixture share token only for historical baseline reads.
Version-two live reads need no token. A working isolated stack remains unavailable, so no speedup is claimed.
