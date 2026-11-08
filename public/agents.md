# Pancake public agent guide

Pancake exposes read-only fantasy basketball data for every non-deleted league.
No login, token, Supabase key, or commissioner action is required.
The production API v2 is live.

## Install the CLI

The CLI requires Node 22 or later and has no runtime dependencies.
The `@pancake/cli` package is not published on npm.
Install from the public repository:

```sh
git clone https://github.com/jormyy/pancake.git
cd pancake
npm install --global ./packages/pancake-cli
pancake leagues --limit 2 --json
```

From a checkout, the same command works without installation:

```sh
node packages/pancake-cli/bin/pancake.mjs leagues --limit 2 --json
```

An anonymous production read returns this shape and example data:

```json
{
  "$schema": "urn:pancake:public:v2:leagues",
  "version": 2,
  "resource": "leagues",
  "items": [
    {
      "id": "faab8d8f-6a60-4bbc-8f5d-44050b652cdd",
      "name": "OFFICIAL LEAGUE",
      "status": "active"
    }
  ],
  "nextCursor": null
}
```

League names, records, and IDs can change. Discover IDs before each new workflow.

## Discover leagues and schemas

Use `leagues` for league IDs. Use `teams --league ID` for team IDs.
Team IDs identify league memberships, not user accounts.
Every data command except `leagues` requires `--league`.
`rosters` also requires `--team`.

```sh
pancake teams --league faab8d8f-6a60-4bbc-8f5d-44050b652cdd --limit 2 --json
pancake rosters --league "$LEAGUE_ID" --team "$TEAM_ID" --json
pancake describe teams
pancake explain trades.completedAt
```

`describe` lists commands, options, response schemas, and exit codes.
`explain` returns the schema for a resource or field. Both commands work offline.
The package includes the [v2 JSON schemas](https://github.com/jormyy/pancake/blob/main/packages/pancake-cli/schemas/v2.json).
The [option definitions](https://github.com/jormyy/pancake/blob/main/packages/pancake-cli/schemas/options-v2.json) list each resource's filters, sort fields, and default order.

Resources include `leagues`, `league`, `seasons`, `teams`, `players`, `free-agents`, `rosters`, `standings`, `matchups`, `scores`, and `schedule`.
They also include `player-stats`, `projections`, `drafts`, `draft-results`, `picks`, `trades`, `trade-assets`, and `transactions`.

## Call the API

The base URL is `https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api`.
Use `GET /public/v2/<resource>`. Query parameters use the CLI option names without `--`.

```sh
curl 'https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api/public/v2/leagues?limit=2'
curl 'https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api/public/v2/teams?league=faab8d8f-6a60-4bbc-8f5d-44050b652cdd&limit=2'
```

Successful JSON responses contain `$schema`, `version`, `resource`, `items`, and `nextCursor`.
The CLI uses this API by default. `--api-url` overrides `PANCAKE_API_URL`, which overrides the default.
JSON is the default for redirected stdout. `--json` and `--text` select the output format.
Only data goes to stdout. Errors go to stderr.

## Page and sort results

`limit` defaults to 25 and accepts 1 through 50.
Use `sort` with a resource's scalar public field and `direction` with `asc` or `desc`.
Defaults vary by resource. Secondary sort keys remain ascending, with `id` as the final tie-breaker.

```sh
pancake players --league "$LEAGUE_ID" --limit 50 --sort name --direction asc --json
pancake players --league "$LEAGUE_ID" --limit 50 --sort name --direction asc --cursor "$NEXT_CURSOR" --json
```

Pass `nextCursor` unchanged as `cursor`, with the same resource, league, filters, limit, and sort options.
Stop when `nextCursor` is null. Do not infer an end from a short page.
Concurrent data changes can shift pages. Restart discovery for a fresh scan.
Offsets above 100,000 return an error.

## Limits and errors

The API allows 60 reads per client-IP bucket per minute.
Shared networks can share a bucket. HTTP 429 includes `Retry-After` in seconds.
The CLI does not retry 429 or invalid requests.
It retries transport failures and HTTP 502, 503, and 504 at most twice within one 15-second budget.
`--no-cache` disables the CLI cache. Cached responses require server revalidation.

Responses and CLI output are capped at two MiB.
Oversized pages return fewer records and a continuation cursor.
Public strings have schema bounds. Fields marked `x-overflow: truncate` return a bounded prefix.

A request without the required league returns HTTP 400 with this shape:

```json
{
  "$schema": "urn:pancake:public:v2:error",
  "version": 2,
  "error": { "code": 400, "message": "Invalid request" }
}
```

HTTP 404 means the public resource is unavailable, including private or unknown object IDs.
HTTP 405 rejects writes. HTTP 410 retires v1 routes. HTTP 503 means public data is unavailable.
CLI JSON errors use `$schema: "urn:pancake:cli:v2:error"` and an exit code in `error.code`.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Missing or invalid option, UUID, or request |
| 4 | Unavailable public resource |
| 5 | Rate limit |
| 6 | Transport failure before any HTTP response |
| 7 | Server, response, schema, or output failure |

## Privacy

The API excludes accounts, emails, profiles, invite codes, notifications, messages, and lineup assignments.
It excludes claims, private bids, pending trade offers, negotiations, notes, veto votes, and trade estimates.
Only completed trades with a completion timestamp are public. Accepted trades awaiting execution are excluded.
Completed auction sale prices are public. Budget-transfer amounts are excluded.
`free-agents` includes unrostered players on waivers.
`waiverEligible` describes public availability, not whether a manager's claim can succeed.

See the [maintainer reference](https://github.com/jormyy/pancake/blob/main/docs/public-cli.md) for the field inventory and operational checks.
