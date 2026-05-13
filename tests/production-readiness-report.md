# Production Readiness Blocker Check

- Status: BLOCKED
- Generated: 2026-05-13T21:02:47.434Z

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
| Linked Supabase DB query access | BLOCKED | Initialising login role... / unexpected login role status 544: {"message":"Failed to create login role: Connection terminated due to connection timeout"} / Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD |
| Linked Supabase migration dry-run | BLOCKED | Initialising login role... / unexpected login role status 544: {"message":"Failed to create login role: Connection terminated due to connection timeout"} / Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD |
| Hosted Fastify health endpoint reachable | PASS | <remote configured> returned healthy JSON. |
| Hosted Fastify secret-key env verified | BLOCKED | Deploy a backend that exposes /health.supabaseAdminKeyMode, or set PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED=1 only after the host has PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY configured. |
| Railway CLI authenticated | BLOCKED | Unauthorized. Please login with `railway login` |
| Remote legacy Supabase JWT keys disabled/revoked | BLOCKED | Supabase API-key metadata still includes legacy key record(s): anon, service_role. |

## Notes

- This check intentionally avoids printing secret values.
- Manual flags are only accepted for host/dashboard operations that are not readable through local repo or Supabase CLI state.
- Before disabling legacy Supabase JWT keys, deploy hosted Fastify with `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY` and verify `/health` reports `supabaseAdminKeyMode=modern-secret`.
- To disable legacy Supabase JWT keys after hosted Fastify is verified, use the Supabase Management API endpoint: `PUT https://api.supabase.com/v1/projects/{ref}/api-keys/legacy?enabled=false`.
- To unblock linked Supabase migrations, provide `SUPABASE_DB_PASSWORD` or restore Supabase temporary login-role creation, then rerun `supabase db query --linked "select now();"` and `supabase db push --dry-run`.
- To unblock hosted Fastify verification from this machine, authenticate Railway with `railway login` or provide a valid Railway token/session for `npx --yes @railway/cli whoami`.
- No GitHub-hosted Railway deploy fallback is configured: the repository has only the `Tests` workflow, and repository/environment secrets and variables are empty.
