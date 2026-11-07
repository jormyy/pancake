# Pancake CLI

Read public data from every non-deleted league without signing in or obtaining a share token.
Requires Node 22 or later. The package has no runtime dependencies.

```sh
npm install -g ./packages/pancake-cli
pancake leagues --json
pancake teams --league "$LEAGUE_ID" --json
pancake rosters --league "$LEAGUE_ID" --team "$TEAM_ID" --json
pancake free-agents --league "$LEAGUE_ID" --query Jokic
pancake trades --league "$LEAGUE_ID"
pancake trade-assets --league "$LEAGUE_ID" --trade "$TRADE_ID"
pancake describe
pancake explain trades.completedAt
```

The default API is `https://ceeytbfmwsnzalxlkalc.supabase.co/functions/v1/api`.
API v2 becomes available there after this release is deployed. No endpoint configuration is needed after release.
Override it with `PANCAKE_API_URL` or `--api-url` when needed.

Every data command except `leagues` requires `--league`. Use `describe` for commands, filters, schemas, and exit codes.
The JSON contract is `schemas/v2.json`. Continue pagination with the returned `nextCursor` and unchanged options.
Version two replaces token-scoped access. Version one routes return HTTP 410.

Only completed trades with a completion time are public. Pending offers, accepted unexecuted trades, bids, claims, messages, account data, and lineups are excluded.
Waiver eligibility describes an unrostered player. It does not reveal a manager's pending claims or legal roster capacity.
No share token, Supabase key, database connection, or commissioner action is required.
The package contains no operator command and performs no mutations.

Stdout contains data; stderr contains errors. Use `--json`, `--text`, `--no-cache`, or `--cache-dir` as needed.
Requests have a 15-second total timeout and at most two retries for safe transient failures.
Output is capped at two MiB. Page sizes are capped at 50.
Missing required or malformed UUID options fail locally with a lookup command.
Exit codes are 0 for success, 2 for usage and invalid options, 4 for valid but unavailable resources, 5 for rate limits, 6 for network failure, and 7 for server/schema failures.

See [the public CLI guide](../../docs/public-cli.md) for coverage, privacy assumptions, verification, and database recovery.
Database execution and production verification remain pending until a real stack is available.
