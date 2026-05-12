# Multi-Season E2E Soak Report

- Status: PARTIAL
- Started: 2026-05-12T02:08:21.313Z
- Finished: 2026-05-12T02:08:28.387Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 1 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 2 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 3 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 4 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 5 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 6 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 7 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 8 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 9 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |
| 10 | PASS | D.0 invariant boundary checks passed; scenario/browser steps pending |

## Notes

- This harness is integration/E2E only. It does not run unit tests.
- Configured API base: <remote configured>
- Configured frontend: http://127.0.0.1:8081
- Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.
- Browser smoke: Expo web loaded at `http://localhost:8081`, test user signed in, and Home/Players/Roster/Trades/League opened with no uncaught browser errors.
- Browser smoke warnings: `lib/transactions.ts -> lib/players.ts -> lib/transactions.ts` require cycle; Expo notifications push-token listener unsupported on web.
- Backend smoke: local Fastify starts with `DISABLE_CRON=1` and fake NBA/Sleeper upstreams. Without `DISABLE_CRON=1`, startup jobs write to the configured Supabase project.
- Backend blocker: the configured Supabase project is missing the latest `try_live_poll_lock()` RPC, so migrations are not fully applied there.
