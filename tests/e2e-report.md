# Multi-Season E2E Soak Report

- Status: BLOCKED
- Started: 2026-05-12T02:03:03.963Z
- Finished: 2026-05-12T02:03:03.963Z
- Target seasons: 10
- Fake upstream: http://127.0.0.1:4555

## Season Summary

| Season | Status | Notes |
| --- | --- | --- |
| 0 | BLOCKED | Missing env: E2E_SUPABASE_URL, E2E_SUPABASE_SERVICE_ROLE_KEY, E2E_API_BASE_URL, E2E_FRONTEND_URL |

## Notes

- The soak runner intentionally fails closed until a real test Supabase project, Fastify backend, and Expo frontend are provided.
- Set NBA_CDN_BASE_URL and SLEEPER_BASE_URL to the fake upstream URL when launching backend and Edge functions.

