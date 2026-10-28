<img src="assets/images/pancake_logo.png" alt="Pancake" width="112">

# Pancake

Dynasty fantasy basketball, built for your iPhone.

## What it does

- Dynasty leagues with persistent rosters and future draft picks.
- Startup auctions and rookie drafts.
- Daily lineups with automatic pre-tipoff optimization.
- Scheduled FAAB claims for every available player, with rolling priority.
- Multi-team trades with roster plans.
- Scheduled claims with IR or taxi destinations, plus Rookie and Taxi player tags.
- Live scoring, playoffs, and automatic season rollover.
- Background matchup forecasts and trade estimates, with separate current revaluation.
- One-request screen views, instant cached returns, and safe offline write replay.
- Team timelines and private trade transitions in Activity.
- Installable iPhone PWA with web push notifications.

## Stack

Expo Router, React Native Web, and TypeScript power the client.
Supabase provides Auth, Realtime, PostgreSQL, and Deno Edge Functions.
PostgreSQL enforces league rules; `core/` shares calculations across runtimes.
Home opens the matchup.
League groups Standings, Activity, Picks, Draft, Bracket, and Settings.
Trades groups Offers, Block, History, and Analyzer.
See the [architecture](docs/architecture.md).

## Local development

Use Node 22.12 or later in the Node 22 release line, npm, Docker, and the Supabase CLI.
Run these commands from the repository root:

```sh
npm ci
cp .env.example .env
supabase start
supabase status -o env
```

Set the three public app variables in `.env` from the local stack.
Append `/functions/v1/api` to its API URL for `EXPO_PUBLIC_API_URL`.
Set `PANCAKE_SUPABASE_SECRET_KEY` from the local stack's service key.
Internal jobs require matching `PANCAKE_EDGE_INTERNAL_TOKEN` values in Edge and database settings.
See [local setup](docs/verification.md#local-stack) for dispatch wiring and isolated fixtures.

Run each process in a separate terminal:

```sh
supabase functions serve --env-file .env
npm start
```

## Verification

```sh
npm run check:quality
npm test
npm run test:db
npm run perf:budget
```

The [verification guide](docs/verification.md) covers database, Edge, browser, and release checks.
Run focused checks while developing; regenerate release evidence for the reviewed source.

## Production releases

Database, then Edge, then merge the frontend.
Release 2.4 includes 608 migrations through `20261116000500`.
Follow the ordered [database release steps](supabase/RELEASE-DB.md) before merging.
Local builds do not fetch production assets by default.
Use a verified local predecessor for local update checks.
A merge to main also triggers a Vercel frontend deployment.
The [release gates](docs/verification.md#release-gates) and [artifact contract](docs/release-build-provenance.md) define verification and rollback.

## Documentation

Start with the [documentation index](docs/README.md).
Use the [browser guide](tests/e2e/README.md) for local UI checks.

Brand assets and phone display rules: [Interface design](docs/interface-design.md).

## Public CLI

Read shared league results with the Node 22 `pancake` CLI.
A commissioner creates, rotates, or revokes the league share token.

```sh
npm install -g ./packages/pancake-cli
pancake describe
pancake standings --json
```

Set `PANCAKE_API_URL` and `PANCAKE_TOKEN` before reading a league.
See [Public CLI](docs/public-cli.md) for schemas, filters, scripts, privacy rules, and private operator reporting.
