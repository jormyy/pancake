# Pancake - Dynasty Fantasy Basketball App

A dynasty fantasy basketball app targeting the gap between ESPN (no dynasty support) and Fantrax/Sleeper (poor UX or flawed scoring). Built for managers with busy lifestyles who want meaningful, skill-rewarding gameplay.

## Tech Stack

- **Frontend**: Expo / React Native (TypeScript)
- **Backend**: Supabase Edge Functions + Postgres RPCs + Supabase Cron
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth
- **Real-time**: Supabase Realtime
- **Data Sources**: NBA CDN (schedules/scores) + Sleeper API (players/projections)
- **Hosting**: Supabase (DB/auth/API/cron)

## Getting Started

### Frontend

```bash
npm install
npx expo start
```

### Supabase Edge API

```bash
supabase functions serve api --env-file .env
```

### Environment

Copy `.env.example` to `.env` and fill in the Supabase URL, publishable key, and
`EXPO_PUBLIC_API_URL=https://<project-ref>.supabase.co/functions/v1/api`.
Runtime overrides remain available in local web builds with `?pancake_api_url=...`.

## Project Structure

```
app/          # Expo Router screens (auth, tabs, modals)
backend-legacy-railway/ # Non-runtime Railway/Fastify rollback reference
lib/          # Frontend data layer
  shared/     # Deduplicated utilities
hooks/        # React hooks
components/   # Reusable UI components
constants/    # App constants
types/        # TypeScript type definitions
contexts/     # React context providers
supabase/     # Database migrations and Edge Functions
```

## Key Features

- **Startup auction draft** with real-time bidding via Supabase Realtime
  - **Nomination-order modes** (commissioner-chosen): manager-nominated, by-projection, or alphabetical
  - **Withdraw nomination** before any bid (returns the player to the pool)
  - Free-form bid input (clear/type any value, validated on submit)
- **Snake rookie draft** for annual offseason drafts (pick-ownership ordered)
- **Daily lineups** with manual and auto-set options, tip-off locks (ET)
- **Waiver wire** with priority-based claiming and a 48h clearance window
- **Trades** with players and future draft picks, 24-hour veto window
- **H2H matchups** with cumulative weekly scoring (regular-season only)
- **Playoff bracket** generation and results
- **Push notifications** via Expo (server-emitted only)
- **PWA**: installable web app with an offline app shell (manifest + service worker)

## Web / PWA

The web build (`npx expo export --platform web` → `dist/`) ships **light-only** and is
installable as a PWA. `public/manifest.webmanifest` + `public/sw.js` provide the install
metadata and an offline app shell (network-first navigations falling back to the cached
shell; stale-while-revalidate for static assets; API/realtime calls are never intercepted).
Native (iOS/Android) supports dark mode. `app/+html.tsx` wires the manifest, theme color,
and service-worker registration.

## Data integrity

Only **regular-season** NBA data ever reaches a stat, projection, or score. The NBA-CDN
path filters by `002%` game ids; the historical Basketball-Reference backfill excludes the
postseason (the "Playoffs" divider) and All-Star/exhibition games. The fantasy-points
formula is shared through core/generated adapters for app, Edge, SQL, and the isolated legacy reference
because each runtime needs its own copy — `tests/scoring-parity.test.ts` fails the build if
any copy drifts in formula, category set, DNP handling, or regular-season filtering.
Edge sync source lives under `supabase/shared-src/`; the isolated legacy backend is not a
source for generated runtime files.

## Testing & validation

```bash
npm run lint                       # expo lint
npm run typecheck                  # app
npm run check:edge-shared          # generated Edge scoring/sync parity
deno check supabase/functions/api/index.ts
npm test                           # root + frontend lib + cross-cutting guards
npx expo export --platform web     # web/PWA build
npm audit --audit-level=high       # dependency audit
```

Cross-cutting guard tests: `tests/scoring-parity.test.ts` (scoring drift),
`tests/rls-grants.test.ts` (service-role-only RPCs never granted to client roles, default
PUBLIC EXECUTE revoked, service-role read grants preserved), and Edge/API static guards.
Browser E2E flows live in `tests/e2e/` (see [tests/e2e/README.md](./tests/e2e/README.md));
the multi-season soak is `npm run e2e:soak`.

The latest launch-readiness hardening pass, including the remaining hosted deployment
blockers, is recorded in
[validation/fresh-hardening-report.md](./validation/fresh-hardening-report.md).

## Security posture (summary)

- RLS is enabled on every public table; `anon` has no write capability anywhere.
- All gameplay mutations flow through `SECURITY DEFINER` RPCs or Supabase Edge
  service-role clients; client direct-writes are limited to `profiles` and
  `league_members.team_name`.
- Edge Functions use Supabase secret keys from hosted secrets and a dedicated internal
  token for cron/admin function-to-function calls.
- The public `api` Edge Function verifies the Supabase session token and re-derives the
  acting member from the token before calling service-role-only RPCs.
- The `api` Edge Function is the stable HTTP boundary at
  `/functions/v1/api`; Railway is not part of the target runtime path.

## Legacy Backend Status

`backend-legacy-railway/` is a non-runtime rollback reference for the former
Railway/Fastify service. It is not a root workspace, has no active startup path,
and should be deleted after the Supabase Edge API has stabilized through the next
production validation window.
