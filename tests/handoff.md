# Pancake Production Handoff

- Date: 2026-05-13
- Branch: `refactor/post-cleanup-sweep`
- Pull request: https://github.com/jormyy/pancake/pull/4
- Status: **not production-complete**

## What Is Done

- Phase A audit is documented in `tests/audit-report.md`.
- P0/P1 source fixes are implemented and traced in the audit report.
- Multi-season E2E harness exists under `tests/e2e/` and runs with `npm run e2e:soak`.
- Fake NBA/Sleeper/Expo upstream exists in `tests/e2e/fake-upstream.mjs`.
- The full all-flags 20-season soak passed locally with real local Expo web, Fastify, Supabase, and fake upstreams.
- `tests/e2e-report.md` records the passing 20-season run.
- `tests/e2e-coverage.md` maps every D.SET/D.SEA/D.X/D.LONG prompt requirement to concrete soak evidence.
- `tests/completion-audit.md` is the current checklist for why the high-level goal is not complete.
- `npm run prod:check` writes `tests/production-readiness-report.md` and fails while production blockers remain.
- Local app/E2E env now resolves to modern Supabase keys:
  - frontend: `sb_publishable_...`
  - backend/admin: `sb_secret_...`

## Verified Gates

Latest verification after the modern-key commit:

- `node --check tests/e2e/production-readiness.mjs`
- `node --check tests/e2e/soak.mjs`
- `git diff --check`
- `npm run lint`
- `npm run typecheck`
- `npm run typecheck --workspace backend`
- `npm run typecheck --workspace core`
- `npm run prod:check` runs and correctly exits nonzero while blockers remain.

Latest CLI retry after reading `.env`/`backend/.env`:

- `.env` contains Supabase URL, legacy anon JWT fallback, modern `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and hosted Railway app URL.
- `backend/.env` contains Supabase URL, legacy service-role JWT fallback, and modern `PANCAKE_SUPABASE_SECRET_KEY`.
- Neither env file contains `SUPABASE_DB_PASSWORD`, `DATABASE_URL`, `RAILWAY_TOKEN`, or Railway project credentials.
- `supabase projects list -o json` sees linked project `pancake` as `ACTIVE_HEALTHY`.
- Hosted Fastify `/health` returns `{"status":"ok"}`.
- `supabase db push --dry-run` still fails while creating the temporary login role with HTTP 544 and asks for `SUPABASE_DB_PASSWORD`.
- `npx --yes @railway/cli whoami` installs/runs the Railway CLI but returns `Unauthorized. Please login with railway login`.
- This branch adds a safe hosted backend proof field: `/health` now returns `supabaseAdminKeyMode` as `modern-secret`, `legacy-service-role`, or `missing`. It never returns secret values.
- `npm run prod:check` now accepts hosted Fastify secret-key verification when deployed `/health` reports `supabaseAdminKeyMode=modern-secret`.

## Current Blockers

1. Hosted Fastify/Railway env is not verified.
   - No local Railway CLI/auth path was found.
   - `npx --yes @railway/cli whoami` returns unauthorized without a Railway login.
   - Local `backend/.env` has `PANCAKE_SUPABASE_SECRET_KEY`, but hosted env cannot be inspected from this machine.
   - Current hosted `/health` is reachable but does not yet expose `supabaseAdminKeyMode`, so the deployed backend is older than this verification change.
   - Do not disable legacy Supabase JWT keys until hosted Fastify is confirmed to use `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY`.

2. Linked Supabase Postgres migration access is blocked.
   - `supabase db push --dry-run` fails while creating the temporary CLI login role.
   - Supabase Management API `PATCH /v1/projects/{ref}/database/password` returned HTTP 544.
   - Supabase Management API `POST /v1/projects/{ref}/cli/login-role` also hit the same database-layer timeout.
   - `SUPABASE_DB_PASSWORD` is not available in local env.

3. Remote legacy Supabase JWT keys are still enabled.
   - Supabase Management API read confirmed `api-keys/legacy` is `enabled: true`.
   - The repo and local env are ready for modern keys, but remote legacy-key disable/revocation still needs a successful Management API/Dashboard operation after hosted Fastify is confirmed migrated.

4. Remote draft realtime migration is not verified on the linked project.
   - `supabase/migrations/20260513000001_enable_draft_realtime.sql` is applied locally.
   - It still needs to be pushed/verified against the linked Supabase project after DB access is restored.

## Next Steps

1. Get hosted Railway/Fastify environment access.
   - Verify or set `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY`.
   - Restart/redeploy the hosted backend.
   - Confirm `/health` still passes.

2. Restore linked Supabase DB migration access.
   - Prefer setting `SUPABASE_DB_PASSWORD` in local env if the dashboard reveals it.
   - Otherwise retry Supabase Management API password rotation once the project DB control plane is healthy.
   - Then run `supabase db push --dry-run`.
   - If clean, run `supabase db push` to apply the remaining draft realtime migration.

3. Disable/revoke legacy JWT API keys only after hosted Fastify is confirmed on `sb_secret_`.
   - Use Supabase Management API legacy-key toggle or Dashboard.
   - Rerun `npm run prod:check`.

4. Rerun a final all-enabled soak after remote blockers are cleared.
   - The previous proof was a 20-season local Supabase/Fastify/static Expo run.
   - For final production readiness, repeat against the intended test Supabase/hosted configuration.

## Source Of Truth Files

- `tests/audit-report.md`
- `tests/completion-audit.md`
- `tests/e2e-report.md`
- `tests/e2e-coverage.md`
- `tests/production-readiness-report.md`
- `tests/e2e/README.md`
- `tests/e2e/soak.mjs`
- `tests/e2e/production-readiness.mjs`
