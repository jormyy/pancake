# Pancake

Pancake is a dynasty fantasy basketball web app.
It supports iPhone Safari, an installed iPhone PWA, and desktop browsers.
Leagues use auction and rookie drafts, daily lineups, waivers, trades, and automated season transitions.

## Architecture

| Layer | Implementation |
| --- | --- |
| Web app | Expo Router, React, TypeScript, and React Native Web |
| Backend | Supabase Auth, PostgREST, Realtime, and Edge Functions |
| Rules | PostgreSQL functions enforce ownership, roster limits, deadlines, and scoring locks |
| Automation | PostgreSQL cron dispatches guarded Edge jobs through pg_net |
| Shared logic | `core/` and `supabase/shared-src/` supply generated runtime copies |
| Delivery | Static web export, public boot shell, and service worker |

The app uses Auth, direct database reads and RPCs, and the Edge API.
The Edge API is not the only backend boundary.
See the [architecture](docs/architecture.md) and [route inventory](docs/supabase-backend-route-inventory.md).

## Getting started

Use Node 22, npm, Docker, and the Supabase CLI.
Run these commands from the repository root:

```sh
npm ci
cp .env.example .env
supabase start
supabase status -o env
```

Set the three public app variables in `.env` from that local stack.
Use its API URL with `/functions/v1/api` appended for `EXPO_PUBLIC_API_URL`.
Set `PANCAKE_SUPABASE_SECRET_KEY` from the local stack's service key.
Generate a local `PANCAKE_EDGE_INTERNAL_TOKEN` if you run internal jobs.
Keep its value equal to the database dispatch token; see the [verification setup](docs/verification.md#local-stack).
Never use a hosted secret in a local test.

Run each process in a separate terminal:

```sh
supabase functions serve --env-file .env
npm start
```

`npm start` serves the web app through Expo.
For a release export, run `npm run build:web:release`.
The build writes the stamped app into the generated dist directory.
See [release provenance](docs/release-build-provenance.md) for deployment and artifact checks.

## Checks

| Command | Scope |
| --- | --- |
| `npm run check:quality` | Lint, typechecks, dead code, generated sources, and inventories |
| `npm run check:comprehensive` | Quality plus Edge and database source checks |
| `npm test` | App and shared contract tests |
| `npm run test:db` | Database behavior on an isolated local stack |
| `npm run perf:budget` | Performance budget contract |
| `npm run e2e:web-targets` | Supported browser layouts and optional gameplay |
| `npm run e2e:layout-stability` | Release layout measurements |
| `npm run e2e:season-sim` | Historical replay; requires the dedicated simulator setup |

Use the [verification recipes](docs/verification.md) for prerequisites and focused checks.
Generated reports, screenshots, and snapshots are ignored artifacts. Regenerate them for each run.

## Documentation

The [docs index](docs/README.md) lists the current contracts and operational records.
The [browser guide](tests/e2e/README.md) owns browser and soak setup.
The [benchmark guide](scripts/bench/README.md) owns local capacity measurements.
