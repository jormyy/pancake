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
export NBA_CDN_BASE_URL=http://127.0.0.1:4555/static/json
export SLEEPER_BASE_URL=http://127.0.0.1:4555/v1
```

Run:

```sh
npm run e2e:seed
npm run e2e:soak
```

Outputs:

- `tests/e2e-report.md`
- `tests/e2e-seed-report.md`
- `tests/snapshots/season-<N>/`
- `tests/artifacts/season-<N>/`

The runner fails closed when the real test Supabase/backend/frontend environment is missing or when the linked Supabase project is missing required post-refactor RPCs/columns. A `PARTIAL` report means only the fake-upstream and database invariant boundary checks ran; browser-driven season scenarios still need the `agent-browser` harness before this can count as a passing dynasty soak.
