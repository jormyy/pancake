# Public Pancake CLI

The public API shares league results without member accounts.
A commissioner controls one active share token per league.
The CLI requires Node 22 or later.
It has no runtime dependencies and never prompts.

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

The API reads existing screen functions and the existing matchup view.
It adds no player aggregation or scoring query.
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

## Verification

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
[Integration evidence](release-2.5-integration.md) records the current test counts and limits.
