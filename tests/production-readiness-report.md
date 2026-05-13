# Production Readiness Blocker Check

- Status: BLOCKED
- Generated: 2026-05-13T20:36:24.322Z

| Requirement | Status | Evidence |
| --- | --- | --- |
| Supabase CLI available | PASS | 2.98.2 |
| Supabase project linked | PASS | [linked-project-ref-present] |
| Hosted Edge secret-key dictionary present | PASS | Supabase Edge secrets include SUPABASE_SECRET_KEYS. |
| Supabase API-key metadata readable | PASS | Management API returned 4 API-key metadata row(s); values intentionally not printed. |
| Supabase modern API keys available | PASS | Management API metadata includes publishable and secret API-key records. |
| Local frontend Supabase key is non-legacy | PASS | Frontend/E2E env resolves to an sb_publishable_ key. |
| Local backend Supabase admin key is non-legacy | PASS | Backend/E2E env resolves to an sb_secret_ key. |
| Linked Supabase DB password available | BLOCKED | SUPABASE_DB_PASSWORD is not set. |
| Linked Supabase migration dry-run | BLOCKED | Initialising login role... / unexpected login role status 544: {"message":"Failed to create login role: Connection terminated due to connection timeout"} / Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD |
| Hosted Fastify health endpoint reachable | PASS | <remote configured> returned healthy JSON. |
| Hosted Fastify secret-key env verified | BLOCKED | Deploy a backend that exposes /health.supabaseAdminKeyMode, or set PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED=1 only after the host has PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY configured. |
| Railway CLI authenticated | BLOCKED | Unauthorized. Please login with `railway login` |
| Remote legacy Supabase JWT keys disabled/revoked | BLOCKED | Supabase API-key metadata still includes legacy key record(s): anon, service_role. |

## Notes

- This check intentionally avoids printing secret values.
- Manual flags are only accepted for host/dashboard operations that are not readable through local repo or Supabase CLI state.
