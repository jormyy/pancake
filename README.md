# Pancake - Dynasty Fantasy Basketball App

A dynasty fantasy basketball app targeting the gap between ESPN (no dynasty support) and Fantrax/Sleeper (poor UX or flawed scoring). Built for managers with busy lifestyles who want meaningful, skill-rewarding gameplay.

## Tech Stack

- **Frontend**: Expo / React Native (TypeScript)
- **Backend**: Node.js / Fastify API server with cron jobs
- **Database**: PostgreSQL via Supabase
- **Auth**: Supabase Auth
- **Real-time**: Supabase Realtime
- **Data Sources**: NBA CDN (schedules/scores) + Sleeper API (players/projections)
- **Hosting**: Supabase (DB/auth) + Railway (API)

## Getting Started

### Frontend

```bash
npm install
npx expo start
```

### Backend

```bash
cd backend
npm install
npm run dev
```

### Environment

Copy `.env.example` to `.env` and fill in values for Supabase URL, anon key, and any other required secrets.

## Project Structure

```
app/          # Expo Router screens (auth, tabs, modals)
backend/      # Node.js/Fastify API server + cron jobs
  src/
    routes/   # Fastify route plugins
    sync/     # Data sync modules
    cron/     # Cron job registration
    lib/      # Shared libraries + utils
    plugins/  # Fastify plugins
    schemas/  # Request validation schemas
lib/          # Frontend data layer
  shared/     # Deduplicated utilities
hooks/        # React hooks
components/   # Reusable UI components
constants/    # App constants
types/        # TypeScript type definitions
contexts/     # React context providers
supabase/     # Database migrations
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
formula is duplicated across core (TS), backend (TS), edge (Deno), and SQL because each
runtime needs its own copy — `tests/scoring-parity.test.ts` fails the build if any copy
drifts in formula, category set, DNP handling, or regular-season filtering.

## Testing & validation

```bash
npm run lint                       # expo lint
npm run typecheck                  # app
npm run typecheck:backend          # backend
npm test                           # root + frontend lib + cross-cutting guards
npm test --workspace backend       # backend unit + guard tests
npm run build:backend              # backend tsc build
npx expo export --platform web     # web/PWA build
npm audit --audit-level=high       # dependency audit
```

Cross-cutting guard tests: `tests/scoring-parity.test.ts` (scoring drift),
`tests/rls-grants.test.ts` (service-role-only RPCs never granted to client roles, default
PUBLIC EXECUTE revoked, service-role read grants preserved), `backend/tests/bbref-schedule.test.ts`
(regular-season purity oracle), `backend/tests/notification-security.test.ts` (no client-supplied push content).
Browser E2E flows live in `tests/e2e/` (see [tests/e2e/README.md](./tests/e2e/README.md));
the multi-season soak is `npm run e2e:soak`.

The latest launch-readiness hardening pass, including the remaining hosted deployment
blockers, is recorded in
[validation/fresh-hardening-report.md](./validation/fresh-hardening-report.md).

## Security posture (summary)

- RLS is enabled on every public table; `anon` has no write capability anywhere.
- All gameplay mutations flow through `SECURITY DEFINER` RPCs or the backend service-role
  client; client direct-writes are limited to `profiles` and `league_members.team_name`.
- Backend admin access must use a revealed Supabase `sb_secret_...` key; legacy
  service-role JWTs are rejected at startup.
- The backend authenticates every request (Supabase JWT via `jose`) and re-derives the
  acting member from the token before calling service-role-only RPCs.
- Set `CORS_ALLOWED_ORIGINS` in production to restrict the browser origin surface.
