# Public Pancake CLI

The public API shares league results without member accounts.
A commissioner controls one active share token per league.
The CLI requires Node 22 or later.
It has no runtime dependencies and never prompts.

## Coverage audit before expansion

This audit describes the starting implementation, not a completed privacy proof.
Public means readable without a Pancake account after a commissioner enables league sharing.
No other unauthenticated league view appears in the inspected routes or database policies.
The unauthenticated player headshot route returns NBA images, not league data.

The [public router](../supabase/functions/api/router.ts) dispatches share-token reads before the authenticated screen routes.
The [screen route](../supabase/functions/api/views/index.ts) requires a user account.
The [share-token migration][sharing] restricts token management to commissioners and co-commissioners.
Tokens are league-scoped read capabilities. They are not Supabase keys or operator credentials.

### Resource coverage and gaps

Every resource uses `GET /public/v1/<resource>` and its matching CLI command.
Every database read starts in `public_read(text,text,jsonb)`.
It checks a non-revoked token and a league whose `deleted_at` is null.
It chooses the requested season, or the current season, then impersonates one league member for existing screen functions.
Player statistics and projections select their statistics year separately from the league season.

| Required surface | Existing source query | Record filter and pagination | Gap before expansion |
| --- | --- | --- | --- |
| League settings | `view_settings` through `view_context` | Shared league and selected season; one row | Only name, timezone, season, week, and scoring weights. Roster, waiver, draft, and trade rules are missing. |
| Teams | `view_standings` joins `league_members` and `standings_current` | Shared league; optional team filter after rank assignment | Team identity is only available through standings. No `teams` resource. |
| Rosters | `view_roster` joins `roster_players` and `players` | League, selected season, required team; absent and foreign teams raise the same privilege error | Loads claims, locks, lineup pins, and assignments before discarding them. No direct public projection. |
| Players | `view_players` calls `view_player_search` | Search, player ID, position, name order, limit, offset | Only `player-stats` and `projections`. No player directory or availability. |
| Player statistics | `view_player_search` joins season averages and projections | Requested statistics season; optional player, query, position; limit and offset | Screen payload also loads private claims and locks. Public field projection follows source pagination. |
| Available players, free agents, waiver eligibility | Existing authenticated `view_players` availability filters | `available` excludes roster ownership; `free_agents` also excludes active waiver holds | No public resource or CLI command. No public clear time or eligibility field. |
| Standings | `view_standings` joins `standings_current` | Shared league; current-season cache; win rate, points rate, maximum points, points against, name, ID | No historical standings source. No public sort option. |
| Matchups and results | `v_matchup_detail` joins current `matchups` state | League and season; exclude voided rows; week range and team filters; week and ID order | `matchups`, `scores`, and `schedule` cover the same projection. Add tests for foreign teams and private-record invariance. |
| Draft list | `view_draft_rooms` | Non-mock drafts in selected league season | No public draft-list command. |
| Draft picks | `view_draft_room` after `view_draft_rooms` | Completed non-mock drafts only; picked snake players or sold auction nominations | Only `draft-results`; no draft filter. Auction player ID is null. Each room loads unrelated bids and budgets. Room nomination query caps at 500 before public pagination. |
| Transactions | `view_activity` calls `get_league_activity_feed` | Current-season roster moves plus activity; source limit and offset before public type and team filters | Page length and cursor can depend on discarded events. No explicit completed-trade join for trade move rows. |
| Executed trades and assets | No dedicated public query | `trade_in`, `trade_out`, `trade_completed` are transaction types | No trade resource, participant list, pick assets, or complete multi-team transfer record. |

The [current public reader][reader] defines these source queries and field copies.
The [activity query][activity] paginates the mixed feed before the public reader filters it.
The [player screen][players] reads claims, private transaction state, and lineup support even for public statistics calls.
The [roster screen][roster] also reads private member data before its public field copy.
These dependencies need removal before claiming that private records cannot affect public output or errors.

### Exact version-one field allowlists

The envelope contains only `$schema`, `version`, `resource`, `items`, and `nextCursor`.
The table lists every allowed item field, including nested fields.
The [server contract][contract] recursively strips other fields at serialization.
The [CLI contract][cli-contract] rejects unexpected response fields.
Neither contract alone proves that discarded records cannot affect source queries.

| Resource | Allowed item fields |
| --- | --- |
| `league` | `id`, `name`, `seasonId`, `seasonYear`, `weekNumber`, `timezone`, `scoringSettings.points`, `scoringSettings.rebounds`, `scoringSettings.assists`, `scoringSettings.steals`, `scoringSettings.blocks`, `scoringSettings.turnovers`, `scoringSettings.three_pointers_made`, `scoringSettings.field_goals_made`, `scoringSettings.field_goals_attempted`, `scoringSettings.free_throws_made`, `scoringSettings.free_throws_attempted`, `scoringSettings.double_double`, `scoringSettings.triple_double` |
| `standings` | `teamId`, `teamName`, `rank`, `wins`, `losses`, `ties`, `pointsFor`, `pointsAgainst`, `maxPointsFor` |
| `rosters` | `id`, `teamId`, `isOnIR`, `isOnTaxi`, `player.id`, `player.name`, `player.nbaTeam`, `player.position`, `player.injuryStatus` |
| `matchups` | `id`, `seasonId`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` |
| `scores` | `id`, `seasonId`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` |
| `schedule` | `id`, `seasonId`, `weekNumber`, `endWeekNumber`, `homeTeamId`, `awayTeamId`, `homeTeamName`, `awayTeamName`, `homePoints`, `awayPoints`, `finalized`, `winnerTeamId` |
| `transactions` | `id`, `teamId`, `teamName`, `playerId`, `playerName`, `occurredAt`, `targetTeamName`, `type` |
| `draft-results` | `id`, `draftId`, `draftType`, `overallPick`, `round`, `teamId`, `teamName`, `pickedAt`, `price`, `player.id`, `player.name`, `player.nbaTeam`, `player.position`, `player.injuryStatus` |
| `player-stats` | `id`, `name`, `nbaTeam`, `position`, `seasonYear`, `gamesPlayed`, `fantasyPoints`, `points`, `rebounds`, `assists`, `steals`, `blocks`, `turnovers`, `minutes` |
| `projections` | `id`, `name`, `nbaTeam`, `position`, `date`, `source`, `fetchedAt`, `status`, `fantasyPoints`, `points`, `rebounds`, `assists`, `steals`, `blocks`, `turnovers`, `minutes` |

Transactions accept only `fa_add`, `fa_drop`, `waiver_add`, `waiver_drop`, `trade_in`, `trade_out`, `draft_won`, `carry_over`, and `trade_completed`.
No command currently accepts a custom sort field.
All resource limits default to 25 and cap at 50.
Cursors bind the token, resource, filters, limit, and offset.
The server caps cursor offsets at 1,000,000.

### Functions, grants, and row policies

This is a source audit. Live catalog checks remain required on the isolated stack.
Security-definer code executes with its owner's privileges; RLS is not its public-data boundary.
The public projection and record predicates must therefore enforce the boundary themselves.

| Surface | Privilege and row boundary |
| --- | --- |
| `public_share_token(uuid,text)` | Security definer with empty search path; `private.is_commissioner` gate; execute granted to authenticated and service roles, revoked from PUBLIC and anon. |
| `public_read(text,text,jsonb)` | Security definer with empty search path, one-second lock timeout, three-second statement timeout; execute only for service role. Latest replacement is [retention migration][reader]. |
| `league_share_tokens`, `public_read_log` | RLS enabled; no PUBLIC, anon, or authenticated grants; service role receives table privileges. |
| `view_context`, `view_settings`, `view_standings` | Authenticated screen helpers; member and league context checks. Settings and standings use invoker security. No public-route grant. |
| `view_roster`, `view_players` | Security-definer screen functions with context checks. They are not safe public field boundaries. |
| `view_player_search` | Invoker function; authenticated and service-role execute grants; PUBLIC and anon revoked. Uses player, stats, and projection sources. |
| `view_draft_rooms`, `view_draft_room` | Invoker functions with context checks; authenticated execute; PUBLIC and anon revoked. |
| `view_activity` | Invoker screen function with context check; authenticated execute; PUBLIC and anon revoked. |
| `get_league_activity_feed` | Security definer; requires `auth.uid()` and membership; authenticated and service-role execute; PUBLIC and anon revoked. |
| `v_matchup_detail` | Security-invoker view over matchups and team names; authenticated SELECT. Reader also joins `matchups` for void and week-range state. |
| League, season, membership, roster, matchups, drafts and draft children | Authenticated SELECT with league-membership RLS, directly or through parent rows. See [base row policies][rls] and [matchup policies][matchup-rls]. |
| Global players, games, statistics and projections | Authenticated reference-data SELECT policies; these do not make a league public. See [base row policies][rls]. |
| Trades and assets | [Current trade policy][trade-history] permits league members to read accepted and completed trades; other states require participation. Public scope is stricter. |
| Waiver claims | [Claim policy][claim-rls] permits own pending claims and league resolved claims. [Cancelled-claim fix][cancelled] also restricts cancelled claims to their owner. |
| Waiver holds | [Hold policy][claim-rls] permits league members to read cleared rows or holds with `clears_at > now()`. Expired uncleared rows are hidden. |

Live checks must inspect `pg_proc`, `pg_policies`, `has_function_privilege`, and `has_table_privilege`.
The existing [database test](../tests/db/public-cli.sql) checks public-reader privileges, token rotation, revocation, and resource status codes.
It does not prove the requested invariance under arbitrary private records.

### Trade-state decision

Only `status = 'completed'` with a non-null `completed_at` qualifies for the new public trade projection.
The [acceptance function][trade-write] records all participants' acceptance, sets `status = 'accepted'`, and clears `completed_at`.
The trade can then wait for its veto window or later execution.
The same migration moves player, pick, and FAAB assets before setting `status = 'completed'` and `completed_at = now()`.
It emits `trade_completed` only after that transition.
Thus `accepted` alone does not mean executed, even though authenticated league history displays it.
Pending, rejected, withdrawn, countered, edited, expired, vetoed, and accepted-but-unexecuted records remain outside the public projection.

Public trade items can contain settled player transfers, pick transfers, and settled FAAB transfers.
A settled FAAB transfer is not a waiver bid.
Exclude proposal notes, negotiation links, estimates, veto voters, failure details, planned drops, reservations, and private participant acceptance details.
Filter parent trades before joining assets, counting, sorting, or paging.

### Waiver-field decision

Publish player ownership, availability class, and the clear time of an active waiver hold.
Compute holds only from the shared league and selected season with `cleared_at IS NULL AND clears_at > now()`.
Exclude expired uncleared holds because the application deliberately hides them.
A public eligibility result describes player availability, not whether a particular manager can submit a valid claim.
Manager capacity, reservations, current claims, and budgets must not influence it.

Exclude claims, claim IDs, planned drops, bid amounts, submission priority, claim order, and claim counts.
The [claim screen][claims] returns those fields only for the selected member.
The [team timeline][timeline] removes `bid_amount` from another member's detail payload.
Although resolved claim rows have league-member RLS access, the inspected display does not establish league-wide bid display.
Therefore this feature does not publish historical waiver bids either.
The ordinary waiver order is already displayed league-wide by `view_settings`. It can be public, but must exclude profile identity and private claim order.

### CLI and verification gaps

`describe` and `explain` work offline. They do not read league data.
`--fixture` reads a local JSON fixture instead of the server; it does not establish server privacy.
`db-health --operator-connection` executes a private database query and must leave the public package.
Its only direct package consumers found here are the CLI test and the [old end-to-end script](../tests/e2e/public-cli.mjs).
A separate operator implementation exists in `scripts/db-health`; this task must preserve it.

The current CLI uses a 15-second request timeout and disallows redirects.
It has no retry loop or response-body byte cap.
Its schema caps neither string lengths nor nested object size.
The expanded CLI needs bounded responses and retries only for safe transient read failures.

Missing, revoked, and malformed tokens currently return the same 401 envelope.
Absent or foreign roster teams raise the same database privilege error, which maps to 400.
The completed implementation must test these cases against actual SQL and the installed CLI.
No present test proves equivalent errors for every private-record probe.

### Baseline and verification state

No new behavior is implemented in this inventory step.
The baseline must run before changing server or CLI behavior.
The required mini host has broken Node links and no located Docker, Supabase, or Deno installation.
The card records the missing stack as a machine blocker.
No real league share token is supplied through approved access, so live production reads remain unmeasured.
Do not read credentials or create a production token to remove that blocker.
The historical results below do not verify the current checkout or this feature.

The new measurement harness is `tools/perf/public-cli.mjs`.
It times complete HTTP bodies and records bytes, returned rows, page position, and database statement counts.
Statement counts include nested SQL and the outer request. Statistics introspection queries are excluded.
They are not network round trips or distinct SQL texts.
The stack must have `pg_stat_statements.track = 'all'`, stopped cron jobs, and no other clients.
The harness makes no schema changes and never resets shared database statistics.
Each run uses a new output directory and fails on HTTP errors or oversized bodies.

```sh
export PANCAKE_API_URL=http://127.0.0.1:58921/functions/v1/api
export PANCAKE_TOKEN=local-fixture-share-token
export PANCAKE_TEAM_ID=local-fixture-team-id
export PANCAKE_PERF_DB_URL=local-stack-database-url
node tools/perf/public-cli.mjs --samples=30 --warmup=2 --pages=3 --output=baseline
node --test tools/perf/public-cli.test.mjs
```

Replace placeholders with the disposable stack's own values.
Run the harness on mini against a seeded, task-isolated stack.
Use the same fixture, case file, limits, samples, and host for before-and-after comparisons.
`--cases=file.json` accepts an array of `{ "resource": "player-stats", "query": { "query": "Public" } }` objects.
Without that option, the harness covers every resource in the installed version-one schema.
Requests are spaced at least 1.1 seconds apart to respect the league rate limit.
Warmup samples are excluded. Each page has its own sample count and percentile summary.
A page that ends early does not produce invented later-page samples.

For explicitly approved production reads, omit `PANCAKE_PERF_DB_URL` and use `--live=true` with an HTTPS API URL.
Production statement counts remain unavailable; never substitute local counts for hosted measurements.
The harness writes `samples.jsonl` and `report.json` without response bodies or raw share tokens.
Its seven focused tests check measurement behavior, not API privacy or database correctness.

[sharing]: ../supabase/migrations/20261118000100_public_cli.sql
[reader]: ../supabase/migrations/20261119001600_complete_public_read_retention.sql
[activity]: ../supabase/migrations/20261206000100_trade_pick_labels.sql
[players]: ../supabase/migrations/20261214009300_player_stats_windows.sql
[roster]: ../supabase/migrations/20261214009700_lineup_player_pins.sql
[contract]: ../supabase/functions/api/public/schema.json
[cli-contract]: ../packages/pancake-cli/schemas/v1.json
[rls]: ../supabase/migrations/20260328000004_rls_policies.sql
[matchup-rls]: ../supabase/migrations/20260422000001_matchups_rls.sql
[trade-history]: ../supabase/migrations/20261214005800_league_trade_history.sql
[trade-write]: ../supabase/migrations/20261214010000_trade_rule_error_transport.sql
[claim-rls]: ../supabase/migrations/20260627000018_waiver_claim_privacy.sql
[cancelled]: ../supabase/migrations/20261025000076_cancelled_waiver_privacy.sql
[claims]: ../supabase/migrations/20261205000100_pending_asset_locks.sql
[timeline]: ../supabase/migrations/20261106000200_timeline_producers.sql

## Install and connect

Install the package from this repository:

```sh
npm install -g ./packages/pancake-cli
export PANCAKE_API_URL=https://your-api.example/functions/v1/api
export PANCAKE_TOKEN=your-league-share-token
pancake standings --json
```

Use your API origin. The CLI has no default hosted endpoint.
Use HTTPS outside localhost.
Use environment variables to keep tokens out of command history.
The package has one executable entry: `pancake`.

## Enable, rotate, and revoke sharing

Call the commissioner RPC through an authenticated Supabase client:

```js
const { data, error } = await supabase.rpc('public_share_token', {
  p_league_id: leagueId,
  p_action: 'create',
})
if (error) throw error
console.log(data.token)
```

The RPC accepts `create`, `rotate`, and `revoke`.
Both commissioners and co-commissioners can call it.
`create` fails when an active token exists.
`rotate` returns a new token and invalidates the previous token.
`revoke` disables sharing immediately.
Recreating a revoked token also generates a new value.
Only the creation response contains the raw token.
The database stores its SHA-256 hash.

A share token grants read access to its league only.
A token never grants database access or write access.
Do not place it in URLs, source code, or public logs.

## Commands and filters

Each resource command maps to `GET /public/v1/<command>`.
Every request requires `Authorization: Bearer <share-token>`.

| Command | Result | Extra filters |
| --- | --- | --- |
| `league` | Public league settings and scoring weights | `--season` |
| `standings` | Current standings in published rank order | `--team` |
| `rosters` | Players on one team, including IR and taxi status | `--team` required; `--season` |
| `matchups` | League matchups and published scores | `--season`, `--week`, `--team` |
| `scores` | Same score records as `matchups` | `--season`, `--week`, `--team` |
| `schedule` | League matchup schedule and published results | `--season`, `--week`, `--team` |
| `transactions` | Completed moves from the current season feed | `--team` |
| `draft-results` | Settled results from completed, non-mock drafts | `--season` |
| `player-stats` | Player season averages under league scoring | `--season`, `--player`, `--query`, `--position` |
| `projections` | Current published player projections | `--player`, `--query`, `--position` |

All resource commands accept `--limit` and `--cursor`.
The default limit is 25. The maximum is 50.
`--season` selects the season's starting year.
Player statistics can use seasons before the league was created.
`--week` includes multiweek matchups that cover that week.
`--team` accepts a team ID from `standings`.
Team IDs identify league memberships, never user accounts.
`--player` accepts a player ID from `player-stats`.

Results have deterministic order when source data does not change.
Standings follow published rank. Rosters follow roster entry IDs.
Matchups follow week and ID. Transactions follow newest time and ID.
Draft results follow draft ID and pick order. Players follow display name and ID.

Cursors continue the same resource, token, limit, and filters.
Read until `nextCursor` is null, including after an empty filtered page.
Live edits can shift offset-based pages. Restart a scan when you need one consistent fresh view.

## JSON and schemas

JSON is the default when stdout is not a terminal.
`--json` forces JSON. `--text` forces text.
Errors go to stderr. Resource data goes to stdout.

```json
{
  "$schema": "urn:pancake:public:v1:standings",
  "version": 1,
  "resource": "standings",
  "items": [],
  "nextCursor": null
}
```

The package includes JSON Schema definitions in `schemas/v1.json`.
Every response names its versioned schema.
Unknown private fields are removed before serialization.
Breaking schema changes require a new API version.

```sh
pancake describe
pancake describe player-stats
pancake explain standings.pointsFor
pancake explain rosters.player
```

`describe` returns commands, options, exit codes, and full field schemas.
`explain` returns a resource or field definition.
Both work offline without a token.

## Script examples

Find team names and points with `jq`:

```sh
pancake standings --json | jq -r '.items[] | [.teamName, .pointsFor] | @tsv'
pancake scores --week 3 --json
pancake rosters --team "$TEAM_ID" --json
pancake player-stats --query Jokic --json
```

Read every page from Node:

```js
import { execFileSync } from 'node:child_process'
let cursor
const rows = []
do {
  const args = ['player-stats', '--json', '--limit', '50']
  if (cursor) args.push('--cursor', cursor)
  const page = JSON.parse(execFileSync('pancake', args, { encoding: 'utf8' }))
  rows.push(...page.items)
  cursor = page.nextCursor
} while (cursor)
console.log(JSON.stringify(rows))
```

Give an agent this task:

> Run `pancake describe standings`, then read `pancake standings --json`.
> Compare points and records using only returned fields.
> Stop on an error. Do not infer pending trades, bids, or hidden lineups.

## Privacy and caching

The API omits pending trades, offers, FAAB bids, private notes, and all lineup assignments.
It omits member emails, user IDs, invite codes, and notification settings.
Completed transactions omit free-form text and bid amounts.
Draft results omit open nominations and bid histories.

The starting API reads existing screen functions and the existing matchup view.
Those screen functions load extra private support data before public serialization.
Only the Edge service can call the public-read database function.
The API accepts GET and CORS preflight. Writes return HTTP 405.

Each token permits 60 reads per UTC minute.
HTTP 429 includes `Retry-After` in seconds.
Valid-token attempts count toward the limit, including conditional reads.

Responses include ETags and `private, no-cache, max-age=0, must-revalidate`.
Conditional reads return HTTP 304 when data is unchanged.
Every conditional read still checks token validity.
Errors use `no-store`.

The CLI stores at most 128 response files under `~/.cache/pancake`.
Cache keys include a hash of the URL and token.
Cache files contain no raw token and use owner-only permissions.
The CLI always revalidates cached data. It never returns stale data after an error.
Use `--cache-dir <directory>` to choose another cache or `--no-cache` to disable it.

The audit log stores hourly resource counts and rejected-read counts per league.
It stores no token, IP address, request body, user ID, or response data.
Hourly cleanup removes at most 10,000 expired rows per run.
Each read also removes that league's expired rows.
The retained window is seven days plus the current hour.
This bounds each active league to 1,690 audit rows.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid command, option, filter, or request |
| 3 | Missing, invalid, or revoked token |
| 4 | Resource or season not found |
| 5 | Rate limit reached |
| 6 | Network failure or timeout |
| 7 | Server failure or invalid response schema |
| 8 | Private operator report failure |

## Private operator placeholder

`db-health` is a private operator command, outside the public API.
It requires `psql` and an explicit PostgreSQL connection.
It reports connections, estimated live and dead rows, and recent autovacuum times.
It uses a read-only session with a five-second statement timeout.
It does not report public league data or expose an operator connection to the API.

```sh
pancake db-health --operator-connection "$OPERATOR_DATABASE_URL" --json
```

This is the initial operator report, not a full database audit.
Do not share operator credentials with public CLI users.

## Existing verification recipes

These recipes predate the expansion. They require review before use on a new stack.

Run local tests without a database:

```sh
npx vitest run tests/public-cli
npm run lint:all
npm run typecheck
npm run typecheck:tests
pancake standings --fixture tests/fixtures/public-cli/league.json --json
```

The tests inject private fields, invalid transaction types, bad tokens, and malformed responses.
They cover schema snapshots, cursors, ETags, rate errors, offline fixtures, and exit codes.

Use the assigned private mini stack for database and end-to-end checks.
Keep its project ID `pt4bafableux`, API port `58921`, and database port `58922`.
Bind published ports to `127.0.0.1`. Disable cron before restoring the backup.
Use a Docker bridge with `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`.
Pass that bridge to `supabase start --network-id`.
After `db reset` or `functions serve`, reconnect replaced containers to that bridge.
Recheck published bindings after each restart.
Use only that stack's `supabase status -o env` output.
Never use a hosted endpoint for these checks.

```sh
supabase status -o env > ../public-local.env
node tests/e2e/public-cli.mjs --env=../public-local.env --restore=../fable-public-data.sql.gz
node tests/e2e/public-cli.mjs --env=../public-local.env --edge-env=.env.public-cli
supabase functions serve api --env-file .env.public-cli --no-verify-jwt
node tests/e2e/public-cli.mjs --env=../public-local.env
```

Restore only on a disposable stack. The restore command replaces its league data.
It loads public data, cached player totals, and two private player lookup tables.
It creates local account shells without importing account credentials.
It disables cron to prevent jobs and notifications.

The end-to-end recipe checks SQL permissions, rotation, revocation, retention, all resource routes, and CLI parity.
It checks historical player statistics and week filters.
It creates and removes two completed draft fixtures to test nonempty draft results.
It revokes its share token when finished.
Delete copied backups and local environment files after testing.
Stop the stack and remove `supabase/.temp/start-secrets`.

## Public CLI release order

This adds to the database release order in `supabase/RELEASE-DB.md`.
Release 2.5 requires all migrations through `20261123000100`; see the release contract for the complete order.
Database, then Edge, then merge the frontend.
For this CLI, install or publish the npm package after the Edge API is available.

Apply these migrations after the existing `20261116000500` release head:

| Migration | Change |
| --- | --- |
| `20261118000100_public_cli.sql` | Share tokens, read limits, audit retention, and public resource reads. |
| `20261118000200_public_matchup_state.sql` | Void flags and multiweek ranges from the current matchup row. |
| `20261118000300_public_stats_seasons.sql` | Player statistics from seasons before the league exists. |

The CLI branch originally attests 611 migrations through `20261118000300`.
The integrated release attests 621 migrations through `20261123000100`.
This work performs no hosted release, push, or deployment.

## Original CLI branch verification

The October 28, 2026 check uses Node 22 and the supplied backup on the isolated mini stack.
The backup contains 245,097 game-stat rows, 8,430 games, 2,618 players, and one ten-team league.
The restore also includes cached season totals.

| Check | Result |
| --- | --- |
| Full Vitest suite | 4,030 passed, zero failed, 38 skipped |
| Public route and CLI tests | 64 passed |
| Edge checks | 514 passed, zero failed, 14 ignored |
| Quality checks | Passed |
| Migration attestation | 611 migrations through `20261118000300` |
| Private end-to-end run | All ten resources and CLI responses agree |
| Privacy control | Removing the allowlist causes ten test failures |
| Cache and access control | 304 for unchanged data, 429 at the limit, 401 after revocation |
| Package check | Packed executable and bundled schemas work |

The draft check uses two temporary completed drafts because the backup has none.
The recipe removes both after the check.
It also verifies older player seasons, week filters, and the private operator report.
No hosted release, production request, email, or push notification is part of this check.

## Release 2.5 integration

Deploy the integrated database, then the changed Edge functions, then the frontend and CLI package.
The public routes stay under `api`; they are not separate Edge functions.
The value worker uses internal authorization and has no public route.
The integration checks public database reads with synthetic league fixtures on an empty private stack.
It does not restore the backup or repeat the earlier backup-based browser run.
