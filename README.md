<img src="assets/images/pancake_logo.png" alt="Pancake" width="112">

# Pancake

Dynasty fantasy basketball, built for your iPhone.

## What it does

- Dynasty leagues with persistent rosters and future draft picks.
- Startup auctions and rookie drafts.
- Daily lineups with automatic pre-tipoff optimization.
- Waivers with FAAB bidding and priority.
- Multi-team trades with roster plans.
- Straight-to-IR and straight-to-taxi adds, with Rookie and Taxi player tags.
- Live scoring, playoffs, and automatic season rollover.
- Installable iPhone PWA with web push notifications.

## Stack

Expo Router, React Native Web, and TypeScript power the client.
Supabase provides Auth, Realtime, PostgreSQL, and Deno Edge Functions.
PostgreSQL enforces league rules; `core/` shares calculations across runtimes.
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
npx vitest run <test-file>
npm run perf:budget
```

The [verification guide](docs/verification.md) covers database, Edge, browser, and release checks.
Run focused checks while developing; regenerate release evidence for the reviewed source.

## Production releases

Deploy the database, then Edge, then the frontend.
Follow the ordered [database release steps](supabase/RELEASE-DB.md) before merging; main also triggers a Vercel frontend deployment.
The [release gates](docs/verification.md#release-gates) and [artifact contract](docs/release-build-provenance.md) define verification and rollback.

## Documentation

Start with the [documentation index](docs/README.md).
Use the [browser guide](tests/e2e/README.md) for local UI checks.
