# Pancake

Pancake is a dynasty fantasy basketball web app for iPhone Safari, installed iPhone PWAs, and desktop browsers. Leagues use auction and rookie drafts, daily lineups, waivers, trades, and automated season transitions.

## Architecture

Expo Router and React Native Web provide the client. Supabase provides Auth, database access, Realtime, and Edge Functions. PostgreSQL enforces league rules and dispatches scheduled work. See the [architecture](docs/architecture.md) and [backend route inventory](docs/supabase-backend-route-inventory.md).

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
Internal jobs also require a matching `PANCAKE_EDGE_INTERNAL_TOKEN` in Edge and database settings.
See [local verification setup](docs/verification.md#local-stack) for dispatch wiring and isolated fixtures.
Use local keys for local tests.

Run each process in a separate terminal:

```sh
supabase functions serve --env-file .env
npm start
```

## Verification

| Command | Scope |
| --- | --- |
| `npm run check:quality` | Lint, typechecks, dead code, generated sources, and inventories |
| `npm run check:comprehensive` | Quality, Edge runtime, database types, and function catalog |
| `npm test` | App and shared contract tests |
| `npm run test:db` | Database behavior on an isolated local stack |
| `npm run security:audit` | Dependency advisories and accepted exceptions |
| `npm run perf:budget` | Performance budget contract and optional report enforcement |
| `npm run e2e:web-targets` | Supported browser layouts and optional gameplay |
| `npm run e2e:layout-stability` | Release layout measurements |
| `npm run e2e:season-sim` | Historical replay with a dedicated simulator stack |

The [verification guide](docs/verification.md) defines prerequisites and focused checks.
Regenerate ignored reports, screenshots, and snapshots for each release.

## Production releases

`npm run build:web:release` writes the stamped frontend artifact to `dist/`.
The protected `Deploy production` workflow verifies frontend/backend compatibility and the approved migration plan.
It applies migrations, deploys the stamped Edge artifact, promotes the frontend, and verifies production.
Recovery retains the additive schema.
`vercel.json` also enables frontend deployments from main; those deployments do not perform the coordinated backend release.
See [release gates](docs/verification.md#release-gates), [artifact provenance](docs/release-build-provenance.md), and [migration history](docs/production-migration-history.md).

## Documentation

The [documentation index](docs/README.md) links each contract and operating guide.
The [browser guide](tests/e2e/README.md) owns browser and soak setup.
The [benchmark guide](scripts/bench/README.md) owns local capacity measurements.
