# Pancake — Dynasty Fantasy Basketball

A dynasty fantasy basketball app targeting the gap between ESPN (no dynasty support) and
Fantrax/Sleeper (poor UX or flawed scoring). Built for managers with busy lifestyles who
want meaningful, skill-rewarding gameplay — and leagues that keep running even when the
commissioner disappears.

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Season autonomy](#season-autonomy)
- [Data sources](#data-sources)
- [Data integrity](#data-integrity)
- [Testing](#testing)
- [Security posture](#security-posture)
- [Deployment](#deployment)
- [Documentation](#documentation)

## Highlights

- **Startup auction draft** with real-time bidding, commissioner-chosen nomination-order
  modes, nomination withdrawal, and free-form validated bids
- **Mock draft rooms** (auction or rookie) with scheduling, realtime multi-user play,
  creator/commissioner deletion, and daily auto-expiry of finished or stale rooms
- **Snake rookie draft** for annual offseason drafts (pick-ownership ordered), with an
  automatic best-available backstop if it never runs by week 1
- **Daily lineups** with manual and auto-set options and ET tip-off locks
- **Player discovery** with indexed search, sort, availability, health, team, playing-day,
  and rookie filters
- **Dynasty Hub** with Hashtag Basketball dynasty rankings, source stat strips, player
  headshots, curated news, and roster-filtered My News
- **Waiver wire** with weekly add limits, rolling or FAAB claim modes, blind bids,
  pending-claim edit/reorder/cancel, and a 48h clearance window
- **Trades** with active-roster players, future draft picks, tradeable FAAB, multi-team
  offers, expiration, counteroffers, outgoing edits, trade block, and a 24h veto window
- **H2H matchups** with cumulative weekly scoring, playoff brackets, and a fully
  automated season lifecycle ([Season autonomy](#season-autonomy))
- **Push notifications** via Expo (server-emitted only)
- **PWA**: installable web app with an offline app shell (manifest + service worker)

## Architecture

| Layer | Technology |
| --- | --- |
| Frontend | Expo / React Native (TypeScript), Expo Router; web export deployed as a PWA |
| API | Supabase Edge Functions (`/functions/v1/api` is the single HTTP boundary) |
| Database | Supabase Postgres — gameplay mutations via `SECURITY DEFINER` RPCs only |
| Scheduling | Supabase pg_cron + `invoke_edge_function`, ET wall-clock and idle gated |
| Realtime | Supabase Realtime (matchups, auction bids) |
| Auth | Supabase Auth |

Scoring and season logic shared across app, Edge, and SQL runtimes is generated from
single sources in `core/` and `supabase/shared-src/` (`npm run generate:edge-shared`);
parity tests fail the build if any copy drifts.

## Getting started

```bash
npm install
npx expo start                                # frontend
supabase start                                # local database stack
supabase functions serve --env-file .env      # Edge API
```

Copy `.env.example` to `.env` and fill in the Supabase URL, publishable key, and
`EXPO_PUBLIC_API_URL=https://<project-ref>.supabase.co/functions/v1/api`.
Runtime overrides remain available in local web builds with `?pancake_api_url=...`.

## Project structure

```
app/          # Expo Router screens (auth, tabs, modals)
components/   # Reusable UI components
constants/    # App constants
contexts/     # React context providers
core/         # Shared scoring/season logic (source of generated runtime copies)
docs/         # Operating docs, ledgers, audits (see docs/README.md)
hooks/        # React hooks
lib/          # Frontend data layer
supabase/     # Migrations, Edge Functions, canonical SQL function sources
tests/        # Vitest suites, DB behavior tests, e2e harnesses (tests/e2e/)
types/        # TypeScript type definitions
```

## Season autonomy

A league whose commissioner disappears in October still finishes its playoffs in April,
rolls into the next season, and is scoring games the following October. The daily
`season-boundary` cron, per league:

1. generates the playoff bracket once the last regular-season week finalizes,
2. advances the bracket round by round — each move waits a **48h stat-correction grace
   window**, and a round is immutable once the next one exists,
3. rolls the season over after the final (waiver priority reseeds from inverse
   standings, FAAB and add-limits reset, the rookie draft gets a default date),
4. generates the new season's matchups so scoring resumes, and
5. auto-completes an unrun rookie draft best-available at the new season's week 1,
   which reactivates the league.

Every step is idempotent, safe to re-run, and defers to a commissioner who already
acted — the commissioner buttons remain as manual overrides. The simulated-season
harness proves the loop across consecutive rollovers and proves it fails red when the
automation is disabled:

```bash
npm run e2e:perpetual                       # 2 consecutive rollovers, zero manual actions
npm run e2e:perpetual -- --disable-boundary # proof the check can go red
```

Evidence and status per acceptance criterion live in
[docs/season-autonomy-ledger.md](./docs/season-autonomy-ledger.md).

## Data sources

All sources are keyless public endpoints with a tested degraded-mode contract: a broken
or reshaped payload is refused (never written), and the next good poll self-heals with
no manual action.

| Source | Provides | Degraded behavior |
| --- | --- | --- |
| NBA CDN | schedule, scoreboard, box scores | refuse bad payloads; offseason-stale schedule is a skip, not a failure |
| ESPN public JSON | player master list, teams, positions, injuries, Dynasty Hub news | refuse truncated payloads (<28 teams / <350 players); ambiguous names skipped, never guessed; a failed news feed never blocks the player sync |
| FantasyPros | projections | parse failure falls back to internal rolling averages |
| HashtagBasketball | dynasty rankings | card-layout parser with legacy-table fallback; degraded scrape refused below 300 rows; stale rankings kept |
| stats.nba.com / NBA.com | draft order (June–July window) | failed day retried on later window days; incomplete boards never half-written |
| Sleeper | dormant fallback player list | behind `PLAYER_SYNC_SOURCE=sleeper` only |

The Sleeper→ESPN migration design and side-by-side parity evidence are in
[docs/sleeper-migration.md](./docs/sleeper-migration.md).

## Data integrity

Only **regular-season** NBA data ever reaches a stat, projection, or score. The NBA-CDN
path filters by `002%` game ids; the historical Basketball-Reference backfill excludes
the postseason and All-Star/exhibition games. The fantasy-points formula is shared
through core/generated adapters for app, Edge, and SQL — `tests/scoring-parity.test.ts`
fails the build if any copy drifts in formula, category set, DNP handling, or
regular-season filtering.

Player discovery uses the `search_players` Postgres RPC as the canonical read path,
backed by the `analytics.mv_player_avg_fantasy_points` materialized view (refreshed
daily, with a fresh-league seeding trigger so new leagues are populated immediately).
The Dynasty Hub loads 5-year Points, 3-year Points, and Rookie ranks in one authorized
batch. It preserves the published Hashtag order and filters each tab in memory. The
service-role-only `replace_dynasty_rankings` RPC replaces each source atomically.
Retention (`prune_unbounded_history`, weekly cron)
prunes only rows the product never reads: ops telemetry past its window, lineups older
than two seasons, old-season non-final standings snapshots, and transactions older than
three seasons.

## Testing

```bash
npm run check:comprehensive   # lint, typechecks, dead-code, parity, edge + db checks
npm test                      # vitest: app, lib, cross-cutting guards (594 tests)
npm run check:edge-functions  # deno check + deno test for Edge functions
npm run test:db               # DB behavior suites against the local stack
npm run perf:budget           # top-workflow performance budget contract
npm run e2e:perpetual         # season-autonomy simulation harness
npm run e2e:soak              # exploratory multi-season soak
npm run e2e:soak:release      # coverage-enforcing 20-season release soak (Node 22+)
```

Cross-cutting guard tests: scoring parity, RLS grants, security regressions
(service-role-only RPCs, revoked columns, realtime gating), performance budgets
(`docs/instant-loading.md`), round-robin/standings/scoring property batteries, and a
no-LLM-in-runtime guard. Browser E2E flows live in `tests/e2e/`
(see [tests/e2e/README.md](./tests/e2e/README.md)). Generated reports, screenshots, and
snapshots are ignored artifacts — regenerate them for the run you are validating.
The soak harness itself is audited by forced-red mutation runs
([docs/soak-harness-audit.md](./docs/soak-harness-audit.md)).

## Security posture

- RLS is enabled on every public table; `anon` has no write capability anywhere.
- All gameplay mutations flow through `SECURITY DEFINER` RPCs or Supabase Edge
  service-role clients; client direct-writes are limited to `profiles` and
  `league_members.team_name`.
- Edge Functions use Supabase secret keys from hosted secrets and a dedicated internal
  token for cron/admin function-to-function calls.
- The public `api` Edge Function verifies the Supabase session token and re-derives the
  acting member from the token before calling service-role-only RPCs.

## Deployment

Production releases run through the protected `Deploy production` workflow: it resolves
the ordered production migration history plus attested frontend and Edge releases, soaks
the pending migration range, cross-verifies deployed↔candidate artifacts on the upgraded
schema, bakes the release SHA and an Edge source digest into the artifacts, and promotes
the frontend only after hosted readiness verifies both digests. Vercel also
auto-builds production from `main` (`vercel.json` `deploymentEnabled`), so merges
ship the frontend directly; the protected workflow remains the verified path for
coordinated schema + Edge + frontend releases.

The web build (`npm run build:web:release` → `dist/`) ships light-only and installable
as a PWA; `public/manifest.webmanifest` + `public/sw.js` provide install metadata and an
offline app shell. API/realtime calls are never intercepted by the service worker.

## Documentation

The `docs/` directory is indexed in [docs/README.md](./docs/README.md): operating plans,
the season-autonomy ledger, the Sleeper→ESPN migration record, harness audits, the
backend route inventory, and dated review ledgers under `docs/audits/`.
