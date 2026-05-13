# Production Readiness Blocker Check

- Status: BLOCKED
- Generated: 2026-05-13T19:44:00.271Z

| Requirement | Status | Evidence |
| --- | --- | --- |
| Supabase CLI available | PASS | 2.98.2 |
| Supabase project linked | PASS | [linked-project-ref-present] |
| Hosted Edge secret-key dictionary present | PASS | Supabase Edge secrets include SUPABASE_SECRET_KEYS. |
| Supabase API-key metadata readable | PASS | Management API returned 4 API-key metadata row(s); values intentionally not printed. |
| Linked Supabase DB password available | BLOCKED | SUPABASE_DB_PASSWORD is not set. |
| Linked Supabase migration dry-run | BLOCKED | Initialising login role... / unexpected login role status 544: {"message":"Failed to create login role: Connection terminated due to connection timeout"} / Connect to your database by setting the env var correctly: SUPABASE_DB_PASSWORD |
| Hosted Fastify health endpoint reachable | PASS | <remote configured>/health returned healthy JSON. |
| Hosted Fastify secret-key env verified | BLOCKED | Set PANCAKE_HOSTED_FASTIFY_SECRET_KEY_VERIFIED=1 only after the host has PANCAKE_SUPABASE_SECRET_KEY or SUPABASE_SECRET_KEY configured. |
| Legacy Supabase JWT/service-role rotated | BLOCKED | Set PANCAKE_LEGACY_SUPABASE_JWT_ROTATED=1 only after Supabase Dashboard key/JWT rotation and old credential revocation are complete. |

## Notes

- This check intentionally avoids printing secret values.
- Manual flags are only accepted for host/dashboard operations that are not readable through local repo or Supabase CLI state.
