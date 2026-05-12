# Multi-Season E2E Harness

This harness is the Phase C entrypoint for dynasty soak testing. It starts the fake NBA CDN/Sleeper server on port `4555`, points the app stack at that server through `NBA_CDN_BASE_URL` and `SLEEPER_BASE_URL`, snapshots dynasty-critical tables, and runs D.0 invariant checks at season boundaries.

The runner loads `.env` and `backend/.env` automatically. Existing app variables are accepted as fallbacks:

- `SUPABASE_URL` or `EXPO_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EXPO_PUBLIC_API_URL`

Explicit E2E overrides are still supported:

```sh
export E2E_SUPABASE_URL=...
export E2E_SUPABASE_SERVICE_ROLE_KEY=...
export E2E_API_BASE_URL=http://127.0.0.1:3000
export E2E_FRONTEND_URL=http://127.0.0.1:8081
export E2E_ADMIN_SECRET=...
export E2E_ENABLE_BACKEND_TICKS=1
export E2E_ENABLE_BROWSER_AUTH=1
export E2E_BROWSER_AUTH_USERS=10
export E2E_ENABLE_PICK_CHAIN=1
export E2E_ENABLE_PUSH=1
export E2E_PERF_DRIFT_LIMIT=1.2
export E2E_MEMORY_DRIFT_LIMIT=1.2
export NBA_CDN_BASE_URL=http://127.0.0.1:4555/static/json
export SLEEPER_BASE_URL=http://127.0.0.1:4555/v1
export EXPO_PUSH_URL=http://127.0.0.1:4555/--/api/v2/push/send
```

Run:

```sh
npm run e2e:seed
npm run e2e:soak
```

`e2e:seed` writes `tests/e2e-state.json` with the isolated league and test users for the latest run. The file is ignored because it contains local test credentials. `e2e:soak` automatically scopes invariant checks and snapshots to that league, or you can override it with `E2E_LEAGUE_ID`.

Backend tick routes are available only when the Fastify server is started with both `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`. The soak runner calls them only when `E2E_ENABLE_BACKEND_TICKS=1`. In that mode it runs sync/admin ticks and calls the real season-reset path for the target league at each season boundary, then re-checks invariants including the rolling five-year pick-bank horizon.

Backend tick mode also checks D.X.3 CORS behavior before the season loop. It sends an `OPTIONS` preflight to `/e2e/status` with the configured `E2E_FRONTEND_URL` origin and verifies the response allows the origin, `GET`, and the headers used by the app/E2E routes.

When backend ticks are enabled, the runner also checks D.SEA.1 matchup generation idempotency for the target league. It counts current-season `matchups`, calls `/e2e/generate-matchups` a second time with `force: false`, and fails if the count changes or if a league with enough members has no generated schedule.

Snapshots are written under `tests/snapshots/season-<N>/` after the season boundary checks. When backend ticks are enabled, snapshots are written after the real season reset. Each snapshot includes a `summary.json`, and the runner fails D.SEA.7 if any dynasty-critical table count shrinks across seasons or if `draft_picks`, `league_seasons`, or `waiver_priorities` fail to grow after real resets.

Performance metrics are written to `tests/artifacts/perf-metrics.json`. Runs shorter than 10 seasons record timings and harness memory only. Runs of 10+ seasons fail D.LONG.6 if the latest season runtime is more than `E2E_PERF_DRIFT_LIMIT` above season 1; the default is `1.2` for the requested 20% drift ceiling. Runs of 10+ seasons also fail D.LONG.7 if harness RSS or heap memory exceeds `E2E_MEMORY_DRIFT_LIMIT` above season 1; the default is also `1.2`.

Future-pick chain checks are available with `E2E_ENABLE_PICK_CHAIN=1` or `--pick-chain=true`. The runner creates three accepted pick-only trades for one five-years-out round-one pick, persists the scenario metadata to `tests/artifacts/future-pick-chain.json`, and checks at every season boundary that the exact `draft_picks.current_owner_id` remains the final multi-hop owner. Once the target pick reaches its draft year during a backend-tick run, the runner starts the real rookie draft and verifies the linked `snake_draft_picks.draft_pick_id` slot belongs to the final traded owner; the slot artifact is written to `tests/artifacts/season-<N>/rookie-draft-pick-chain.json`. This covers D.LONG.1/D.LONG.2 ownership-drift invariants through the real `accept_trade_atomic` and rookie-draft seeding paths; it is not a replacement for the full browser trade or rookie-draft workflow.

Push notification interception is available with `E2E_ENABLE_PUSH=1` or `--push=true`. The Fastify backend must be started with `EXPO_PUSH_URL=http://127.0.0.1:4555/--/api/v2/push/send`; the runner fails closed if `/e2e/status` reports any other push URL. Each season sets seeded recipients' `profiles.push_token`, signs in through Supabase Auth as a seeded sender, calls the real authenticated `/notify/trade` route, seeds a real pending waiver claim, runs `/e2e/process-waivers`, and asserts the fake upstream captured both Expo push payloads. Artifacts are written to `tests/artifacts/season-<N>/push-notifications.json`. This covers the trade and waiver notification slices of D.X.1; draft notification assertions remain pending.

Standings/champion history retention is available with `E2E_ENABLE_HISTORY=1` or `--history=true` in backend tick mode. Each season seeds deterministic completed-season standings plus a finalized playoff-final row for the season about to reset, advances the season through the real backend, then verifies all previously seeded standings and champions remain queryable. Artifacts are written to `tests/artifacts/season-<N>/history-retention.json`. This covers the D.LONG.3/D.LONG.4 history-retention slice only; it does not replace full playoff gameplay.

Realtime latency checks are available with `E2E_ENABLE_REALTIME=1` or `--realtime=true`. The runner opens `E2E_REALTIME_CLIENTS` Supabase Realtime clients (default 10) as seeded users, subscribes each one to a disposable `matchups` row update, updates that row through the service-role client, and fails if every subscribed client does not receive the update within `E2E_REALTIME_LATENCY_LIMIT_MS` (default 2000). Subscription setup has its own `E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS` (default 10000). Artifacts are written to `tests/artifacts/season-<N>/realtime-latency.json`. This covers the matchups-update slice of D.X.2; bid-room realtime still requires a draft-room scenario.

Browser smoke runs are available through `npm run e2e:browser-smoke` or `E2E_ENABLE_BROWSER=1 npm run e2e:soak`. They use `agent-browser` with an isolated session, sign in as the seeded commissioner, visit the main tab screens, and write screenshots plus console/error logs under `tests/artifacts/season-<N>/smoke/`. Set `E2E_BROWSER_FULL_SWEEP=1` or `--browser-full-sweep=true` with browser mode to also visit auth, modal, player, auction-draft, and rookie-draft routes (`sign-in`, `sign-up`, `create-league`, `join-league`, `commissioner-settings`, `lineup`, `bracket`, `claim-player`, `player/[id]`, `propose-trade`, `team-roster`, `draft-room`, `rookie-draft-room`). When the seeded league has no draft rows, the sweep creates minimal disposable draft fixtures so the route-load check cannot silently skip those screens. This covers the D.X.5 route-load slice; the full D.SET/D.SEA/D.X/D.LONG gameplay loop remains separate work.

Browser auth runs are available through `npm run e2e:browser-auth` or `E2E_ENABLE_BROWSER_AUTH=1 npm run e2e:soak`. They use isolated `agent-browser` sessions for seeded users, verify a protected route redirects to sign-in, sign in, verify profile/session persistence, sign out through the real profile UI, and verify the auth guard returns. Set `E2E_BROWSER_AUTH_USERS=10` to exercise all seeded users in parallel. This covers D.SET.1 only; it does not replace auction, trade, waiver, lineup, playoff, or rookie-draft browser scenarios.

Outputs:

- `tests/e2e-report.md`
- `tests/e2e-coverage.md`
- `tests/e2e-seed-report.md`
- `tests/e2e-state.json`
- `tests/e2e-browser-report.md`
- `tests/e2e-browser-auth-report.md`
- `tests/artifacts/perf-metrics.json`
- `tests/artifacts/future-pick-chain.json`
- `tests/snapshots/season-<N>/`
- `tests/snapshots/season-<N>/summary.json`
- `tests/artifacts/season-<N>/`
- `tests/artifacts/season-<N>/push-notifications.json`
- `tests/artifacts/season-<N>/rookie-draft-pick-chain.json`

The runner fails closed when the real test Supabase/backend/frontend environment is missing or when the linked Supabase project is missing required post-refactor RPCs/columns. A `PARTIAL` report means only the fake-upstream and database invariant boundary checks ran; browser-driven season scenarios still need the `agent-browser` harness before this can count as a passing dynasty soak.
