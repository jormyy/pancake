<img src="assets/images/pancake_logo.png" alt="Pancake" width="112">

# Pancake

Dynasty fantasy basketball, built for your iPhone.

Pancake runs dynasty leagues with persistent rosters, future draft picks, startup auctions, and rookie drafts.
Managers set daily lineups, place scheduled FAAB claims, and make multi-team trades.
The app shows live scores, matchup forecasts, and trade estimates.
It installs as an iPhone PWA with web push notifications.

## Stack

The client uses Expo Router, React Native Web, and TypeScript.
Supabase provides Auth, Realtime, PostgreSQL, and Deno Edge Functions.
PostgreSQL enforces league rules.
`core/` shares calculations across the client, Edge, and tests.
Read the [architecture](docs/architecture.md) before you change a data path.

## Local development

You need Node 22.12 or later in the Node 22 line, npm, Docker, and the Supabase CLI.
Run these commands from the repository root:

```sh
npm ci
cp .env.example .env
supabase start
supabase status -o env
```

Set the three public app variables in `.env` from the local stack.
Set `EXPO_PUBLIC_API_URL` to the local API URL plus `/functions/v1/api`.
Set `PANCAKE_SUPABASE_SECRET_KEY` to the local service key.
Internal jobs need the same `PANCAKE_EDGE_INTERNAL_TOKEN` in Edge and database settings.

Run each process in its own terminal:

```sh
supabase functions serve --env-file .env
npm start
```

## Verification

```sh
npm run check:quality
npm test
npm run test:db
```

The [verification guide](docs/verification.md) covers isolated stacks, database recipes, browser checks, and the rules for evidence.

## Releases

Release the database first, then Edge, then merge the frontend.
A merge to main deploys the frontend on Vercel.
Follow the [release guide](scripts/release/README.md) and the [database runbook](supabase/RELEASE-DB.md).

## Documentation

| Guide | Use it for |
| --- | --- |
| [Architecture](docs/architecture.md) | Layers, screen views, cache, writes, workers, and the public API |
| [League rules](docs/roster-lifecycle.md) | Rosters, waivers, IR, taxi, trades, drafts, and playoffs |
| [Operations](docs/operations.md) | Scheduler, data sources, live scores, forecasts, and incidents |
| [Verification](docs/verification.md) | Local stack, checks, and evidence rules |
| [Interface design](docs/interface-design.md) | Tokens, shared controls, layout rules, and brand assets |
| [Release guide](scripts/release/README.md) | Release runner, build provenance, and migration history |
| [Database runbook](supabase/RELEASE-DB.md) | Current database release order and rollback |

## Public CLI

The `pancake` CLI reads public data from every league.
It needs no account or token.

```sh
npm install -g ./packages/pancake-cli
pancake describe
pancake leagues --json
```

The CLI uses the production Edge API by default; set `PANCAKE_API_URL` to override it.
The [public agent guide](https://pancakedynasty.vercel.app/agents.md) covers commands and schemas.
