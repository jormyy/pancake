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
export E2E_ENABLE_PICK_CHAIN=1
export NBA_CDN_BASE_URL=http://127.0.0.1:4555/static/json
export SLEEPER_BASE_URL=http://127.0.0.1:4555/v1
```

Run:

```sh
npm run e2e:seed
npm run e2e:soak
```

`e2e:seed` writes `tests/e2e-state.json` with the isolated league and test users for the latest run. The file is ignored because it contains local test credentials. `e2e:soak` automatically scopes invariant checks and snapshots to that league, or you can override it with `E2E_LEAGUE_ID`.

Backend tick routes are available only when the Fastify server is started with both `ENABLE_E2E_ROUTES=1` and `E2E_ADMIN_SECRET`. The soak runner calls them only when `E2E_ENABLE_BACKEND_TICKS=1`. In that mode it runs sync/admin ticks and calls the real season-reset path for the target league at each season boundary, then re-checks invariants including the rolling five-year pick-bank horizon.

Future-pick chain checks are available with `E2E_ENABLE_PICK_CHAIN=1` or `--pick-chain=true`. The runner creates three accepted pick-only trades for one five-years-out round-one pick, persists the scenario metadata to `tests/artifacts/future-pick-chain.json`, and checks at every season boundary that the exact `draft_picks.current_owner_id` remains the final multi-hop owner. This covers the D.LONG.2 ownership-drift invariant through the real `accept_trade_atomic` path; it is not a replacement for the full browser trade workflow.

Browser smoke runs are available through `npm run e2e:browser-smoke` or `E2E_ENABLE_BROWSER=1 npm run e2e:soak`. They use `agent-browser` with an isolated session, sign in as the seeded commissioner, visit the main tab screens, and write screenshots plus console/error logs under `tests/artifacts/season-<N>/smoke/`. This is a smoke sweep only; the full D.SET/D.SEA/D.X/D.LONG browser scenario loop remains separate work.

Outputs:

- `tests/e2e-report.md`
- `tests/e2e-seed-report.md`
- `tests/e2e-state.json`
- `tests/e2e-browser-report.md`
- `tests/artifacts/future-pick-chain.json`
- `tests/snapshots/season-<N>/`
- `tests/artifacts/season-<N>/`

The runner fails closed when the real test Supabase/backend/frontend environment is missing or when the linked Supabase project is missing required post-refactor RPCs/columns. A `PARTIAL` report means only the fake-upstream and database invariant boundary checks ran; browser-driven season scenarios still need the `agent-browser` harness before this can count as a passing dynasty soak.
