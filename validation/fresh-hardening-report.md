# Fresh Hardening Report

- Date: 2026-06-28
- Status: BLOCKED for final ship
- Scope: baseline, logic hardening, production DB integration, security, code quality, code review, production web build, and browser route regression.

## Green Gates

- Baseline/build: `npm ci`, `npm audit --audit-level=high`, lint, app/core/backend typecheck, backend build, edge-shared check, core CJS check.
- Tests: root `npm test` passed 22 files / 306 tests; core passed 8 files / 82 tests; backend passed 17 files / 130 tests.
- Local DB: full `npx supabase db reset` passed; `supabase db lint --local --fail-on warning` passed.
- Linked DB: `supabase db push` applied `20260628000001_db_lint_unused_reads.sql` and `20260628000002_service_role_select_grants.sql`; linked lint and dry-run are clean.
- Production data health: `npm run prod:data-health -- --linked --allow-prod-writes` passed, including cleanup-backed CRUD on `live_poll_leases`.
- Security: local and linked DB catalog passed, local and linked Edge auth probes passed, local secret scan passed.
- Web regression: `npx expo export --platform web` passed; `npm run e2e:browser-smoke` passed a full route sweep against local Supabase/Fastify with screenshot capture skipped due local `agent-browser` screenshot transport failure. Routes visited: auth sign-in/sign-up, home, players, roster, trades, league, create/join league, commissioner settings, lineup, bracket, claim-player, player detail, propose trade, team roster, draft room, rookie draft room.
- Backend deployment build simulation: a clean-copy `cd backend && npm ci --workspaces=false && npm run build` passed after syncing `backend/package-lock.json` with the `@pancake/core` dependency.
- GitHub/Railway triage: Railway deployment `5227826756` for `dc9b0cc` failed with an empty GitHub deployment-status description; the commit status target points at service `d439c639-9720-41d2-8047-c09bf5050400` and deployment/query id `61b758d0-8c59-4ca8-b523-f7bdeb6ca0a2`. Replaying `origin/main`'s clean backend install reproduces a concrete repo-side failure: `npm ci` rejects the stale lockfile because `@pancake/core@1.0.0` is missing. Replaying the same clean install/build against this commit passes.

## Changes Made

- Added DB lint no-op reads for stable RPC parameters/row variables and made the patch migration fail closed if expected function bodies drift.
- Restored trusted `service_role` SELECT/default SELECT privileges on public relations so modern Supabase secret keys can read through PostgREST after client grant lockdown.
- Added static and live DB catalog guards for service-role read grants.
- Enforced backend admin keys as revealed `sb_secret_...` values; non-secret legacy service-role JWT-shaped values now fail startup/client construction.
- Fixed local Supabase Edge runtime secrets so internal Edge auth can be exercised without committing a hosted secret.
- Hardened production readiness checks so public `/health` is not accepted as proof of hosted secret-key posture.
- Fixed browser smoke login selectors to use accessibility snapshot refs and explicit `/sign-in`.
- Updated E2E docs and env examples to distinguish revealed `sb_secret_...` values from Supabase Management API metadata IDs.
- Synced the backend lockfile so Railway's backend-root install path includes `@pancake/core`.

## Remaining Blockers

`npm run prod:check` remains BLOCKED:

- The local configured backend admin key starts with `sb_secret_` but is not usable against hosted PostgREST; the CLI `--reveal` attempt timed out, so the revealed hosted secret value could not be obtained from this machine.
- The macOS keychain contains an older Supabase CLI token format; `SUPABASE_ACCESS_TOKEN=<keychain token> npx supabase projects api-keys --reveal` is rejected because the newer CLI requires an `sbp_...` access token.
- Hosted Fastify is stale or misconfigured: public `/health` still reports `legacy-service-role` from an older deployment.
- The latest Railway deployment recorded for `origin/main` failed; GitHub exposes only pending/failure statuses and Railway target URLs, not the build/runtime log body. The public Railway page returns the web app shell without embedded log details.
- Railway CLI is not authenticated here, so hosted Fastify env/deploy state cannot be inspected or fixed.
- Supabase API-key metadata still includes legacy `anon` and `service_role` JWT records; they must not be revoked until hosted Fastify is verified on modern secret keys.

Final deployment, key rotation, push/merge completion, and two clean outer gauntlet passes are blocked until Railway/Supabase dashboard credentials or equivalent automation are available.
