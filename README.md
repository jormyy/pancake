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
- **Player discovery** with indexed search, sort, availability, health, team, playing-day, and rookie filters
- **Dynasty Hub** with Hashtag Basketball dynasty rankings, full source stat strips, player headshots, curated news, and roster-filtered My News
- **Waiver wire** with weekly add limits, rolling or FAAB claim modes, blind bids,
  pending-claim edit/reorder/cancel, and a 48h clearance window
- **Trades** with active-roster players, future draft picks, tradeable FAAB, optional
  expiration, counteroffers, outgoing edits, trade block, and a 24-hour veto window
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
formula is shared through core/generated adapters for app, Edge, and SQL
because each runtime needs its own copy — `tests/scoring-parity.test.ts` fails the build if
any copy drifts in formula, category set, DNP handling, or regular-season filtering.
Edge sync source lives under `supabase/shared-src/`.

Player discovery uses the `search_players` Postgres RPC as the canonical read path. The RPC starts
from the full player pool, left-joins season stats, preserves players without current-season rows,
and uses indexed name/stat access for high-volume search and sorting. League-scored fantasy averages
come from the `analytics.mv_player_avg_fantasy_points` materialized view (refreshed daily); a league
created after the last refresh is seeded into `analytics.player_avg_fantasy_points_fresh` by an
AFTER INSERT trigger (current season only) so its FP column and `fpts` sort are populated immediately,
and those rows are pruned once the nightly refresh folds the league into the view. The FP column is
never a fallback to plain points — a player with no league-scored average shows an em dash, not a
duplicate of PTS. The Dynasty Hub reads Hashtag
Basketball rows from `dynasty_rankings`, joins matched players for app headshots and injuries, and
loads rankings 50 rows at a time. `sync-rankings` replaces that read model through the
service-role-only `replace_dynasty_rankings` RPC and also keeps `players.dynasty_rank` in sync for
player detail context. Curated news still lives in `dynasty_news`, which is client read-only and
service-role managed.

## Testing & validation

```bash
npm run lint                       # expo lint
npm run typecheck                  # app
npm run check:edge-shared          # generated Edge scoring/sync parity
deno check supabase/functions/api/index.ts
npm test                           # root + frontend lib + cross-cutting guards
npm run perf:budget                # top workflow performance budget contract
npx expo export --platform web     # web/PWA build
npm audit --audit-level=high       # dependency audit
```

Cross-cutting guard tests: `tests/scoring-parity.test.ts` (scoring drift),
`tests/rls-grants.test.ts` (service-role-only RPCs never granted to client roles, default
PUBLIC EXECUTE revoked, service-role read grants preserved),
`tests/security-regression.test.ts` (push_token column stays revoked, realtime tables
stay RLS-gated, invite-join error stays generic, invite-code generation stays server-only,
no anon writes on gameplay tables — each checks the current effective state so a later
migration can't silently reopen the hole),
`tests/performance-budget.test.ts` (instant-loading workflow and budget
contract), plus behavioral Edge/API checks.

Deterministic-core battery: `supabase/functions/api/matchups.test.ts` (round-robin
invariants over team counts 2–14 + a mutation-proof), `tests/lib/standings-tiebreak.test.ts`
(6-key precedence + shuffle stability), `core/tests/scoring-properties.test.ts`
(DNP⇒0, additivity, per-stat monotonicity), the database integration suite
(auction/waiver ordering and atomicity), and `tests/no-llm-guard.test.ts`
(no model SDK in runtime logic).
Browser E2E flows live in `tests/e2e/` (see [tests/e2e/README.md](./tests/e2e/README.md));
the exploratory multi-season soak is `npm run e2e:soak`; the coverage-enforcing release run is
`npm run e2e:soak:release`. E2E reports, screenshots,
snapshots, loop logs, and web export output are generated artifacts and are
ignored; regenerate them for the run you are validating instead of committing
stale outputs.

Dynasty transaction release gates:

```bash
npm run e2e:dynasty-release-final-gate
npm run e2e:browser-waiver
npm run e2e:browser-trade-post-deadline
```

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
  `/functions/v1/api`; no alternate backend is part of the target runtime path.

## Retired Backend

The former standalone backend has been removed. Supabase Edge Functions and
Postgres RPCs are the only runtime API path.
