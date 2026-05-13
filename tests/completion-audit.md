# Pancake Completion Audit

- Updated: 2026-05-13
- Branch: `refactor/post-cleanup-sweep`
- Latest local branch includes the history-enabled soak proof, Expo patch alignment, production-gate clarification, local modern Supabase key migration, hosted key-mode health verifier, and CI workspace fix commits.
- Verdict: **not complete**

## Objective

Take Pancake from feature-complete to production-ready by:

1. Auditing the full codebase and writing `tests/audit-report.md`.
2. Refactoring every P0/P1 finding with traceability back to the audit.
3. Proving multi-season dynasty behavior with a real Expo frontend, real Fastify backend, real Supabase test project, fake NBA/Sleeper upstream, and a soak harness that runs at least 10 seasons and continues through 20 clean seasons or first failure.

## Evidence

| Requirement | Status | Evidence |
| --- | --- | --- |
| Phase A audit report | PASS | `tests/audit-report.md` exists and contains severity-ranked findings plus post-refactor deltas. |
| P0/P1 source fixes | PARTIAL | P0/P1 fixes are documented in `tests/audit-report.md`. Current source and reachable local Git history have no literal JWT matches. GitHub branch refs were force-updated to rewritten commits. Local `.env` now resolves the frontend to an `sb_publishable_` key and backend/E2E admin access to an `sb_secret_` key. Hosted Fastify env, remote legacy JWT disable/revocation, and linked DB migration access remain operational follow-up items. |
| Secret-bearing Git history purge | PASS | `git grep -I -n -E 'eyJ...JWT...' $(git rev-list --all) -- .` returned no matches locally. `git ls-remote --heads origin` shows rewritten branch tips for `main`, `michael-branch`, `fix/lineup-lock-taxi-squad-week-transition`, and `refactor/post-cleanup-sweep`. |
| Supabase Edge deployment after secret fix | PASS | All hosted Edge Functions were redeployed with previous JWT verification modes preserved. Hosted `verify?action=validate-db` returned HTTP 200 after deployment. |
| Hosted Fastify secret-key migration | BLOCKED | Local backend `.env` now has `PANCAKE_SUPABASE_SECRET_KEY` populated from the Supabase CLI API-key output, but the hosted Fastify deployment env cannot be inspected or updated from this environment. `npm run prod:check` now verifies Railway CLI auth directly; current Railway CLI check is unauthenticated. |
| Legacy Supabase JWT/service-role rotation | BLOCKED | Local app/E2E env now resolves to Supabase's modern publishable/secret keys. `npm run prod:check` now verifies this from Supabase API-key metadata, and current metadata still includes legacy `anon` and `service_role` records. Disabling/revoking the hosted project's legacy JWT keys requires the Supabase Management API legacy-key toggle or Dashboard flow. |
| Build gates | PASS | Latest reruns after the history-enabled report refresh and Expo patch alignment: `npm run lint`, `npm run typecheck`, backend/core typechecks, backend build, `deno check supabase/functions/_shared/supabase.ts`, `node --check tests/e2e/soak.mjs`, `npx expo-doctor`, `npm audit --audit-level=high`, backend high audit, and `git diff --check` all passed. PR #4 also has passing GitHub `Frontend lib tests` and `Backend tests`; backend CI now installs root workspace dependencies so `@pancake/core` resolves. |
| 20-season soak proof | PASS | `tests/e2e-report.md` now records a history-enabled all-flag 20-season local Supabase/Fastify/static Expo/fake-upstream run with `Status: PASS`, from `2026-05-13T17:09:03.319Z` to `2026-05-13T19:24:28.135Z`. Every season row passed D.0 boundaries, repeated browser/API gameplay slices, D.LONG.1/D.LONG.2 pick-chain checks, D.LONG.3/D.LONG.4 history retention, D.LONG.5 local migration replay, D.LONG.6 runtime drift, and D.LONG.7 harness memory drift. |
| D.SET.2 create/join lifecycle | PASS | The 20-season all-flag run included `E2E_ENABLE_LEAGUE_LIFECYCLE=1` and `E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1`, so the report records both the 10-user auth/RPC lifecycle and the real Expo create/join form lifecycle every simulated season. |
| D.X.2 score realtime | PASS | The 20-season proof includes 10-client matchup realtime checks. |
| D.X.1 push notifications | PASS | The 20-season proof enabled both fake Expo push intercept modes and captured trade, waiver, and rookie auto-pick draft notifications. |
| D.X.2 auction bid realtime | PASS | The 20-season all-flag run included `E2E_ENABLE_REALTIME=1`; every season row reports realtime matchup and auction bid updates delivered to 10 clients within the gate. |
| Remote Supabase draft realtime migration | BLOCKED | Latest retry of `supabase migration list` against the linked project still failed while creating a temporary login role: Postgres connection timeout, with the CLI asking for `SUPABASE_DB_PASSWORD`. A direct `supabase db query --linked 'select now();'` retry failed at the same login-role step, so the CLI Management API query path does not bypass the remote DB access blocker. The migration is applied locally but not verified on the linked remote project. Supabase Edge secrets do include `SUPABASE_SECRET_KEYS`, but that does not grant direct Postgres migration access. |
| Prompt-to-artifact coverage | PASS | `tests/e2e-coverage.md` now maps every D.SET/D.SEA/D.X/D.LONG row to concrete artifacts from the all-flags 20-season run. The only remaining non-PASS row in that matrix is the P0/P1 operational follow-up row. |
| Production blocker check | BLOCKED | `npm run prod:check` writes `tests/production-readiness-report.md`. Current report verifies Supabase CLI/link/API-key metadata, hosted Edge `SUPABASE_SECRET_KEYS`, modern Supabase API-key records, local frontend `sb_publishable_` usage, local backend `sb_secret_` usage, and hosted Fastify `/health`; it still blocks on missing `SUPABASE_DB_PASSWORD`, linked DB query access, linked migration dry-run timeout, unverified hosted Fastify secret-key env, unauthenticated Railway CLI, and unverified remote legacy JWT disable/revocation. This branch adds `/health.supabaseAdminKeyMode` so a deployed backend can prove `modern-secret` without exposing secrets, but the current hosted deployment does not yet expose that field. |
| Final production-ready exit criteria | FAIL | The blocker list above prevents marking the high-level goal complete. |

## Current Blockers

1. Set hosted Fastify/Railway admin env to a full `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY`.
2. Disable/revoke the hosted project's legacy Supabase JWT keys through the Supabase Management API legacy-key toggle (`PUT /v1/projects/{ref}/api-keys/legacy?enabled=false`) or Dashboard flow.
3. Push `20260513000001_enable_draft_realtime.sql` to the linked Supabase project once remote Postgres connectivity is healthy or `SUPABASE_DB_PASSWORD` is available.
4. Rerun the 20-season all-enabled soak against the hosted test Supabase project after the linked DB migration and hosted env are in place.
