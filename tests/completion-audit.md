# Pancake Completion Audit

- Updated: 2026-05-13
- Branch: `refactor/post-cleanup-sweep`
- Latest local/remote branch commit: `5534747 docs: refresh completion audit tip` before the current browser-lifecycle harness changes.
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
| P0/P1 source fixes | PARTIAL | P0/P1 fixes are documented in `tests/audit-report.md`. Current source and reachable local Git history have no literal JWT matches. GitHub branch refs were force-updated to rewritten commits. Hosted Fastify env and legacy Supabase JWT/service-role rotation remain operational follow-up items. |
| Secret-bearing Git history purge | PASS | `git grep -I -n -E 'eyJ...JWT...' $(git rev-list --all) -- .` returned no matches locally. `git ls-remote --heads origin` shows rewritten branch tips for `main`, `michael-branch`, `fix/lineup-lock-taxi-squad-week-transition`, and `refactor/post-cleanup-sweep`. |
| Supabase Edge deployment after secret fix | PASS | All hosted Edge Functions were redeployed with previous JWT verification modes preserved. Hosted `verify?action=validate-db` returned HTTP 200 after deployment. |
| Hosted Fastify secret-key migration | BLOCKED | No Railway CLI/auth path is available locally. Supabase CLI exposes only masked `sb_secret` values, so the full hosted `PANCAKE_SUPABASE_SECRET_KEY`/`SUPABASE_SECRET_KEY` must be copied from the Supabase dashboard into the Fastify host. |
| Legacy Supabase JWT/service-role rotation | BLOCKED | Supabase's current rotation flow requires Dashboard JWT/signing-key rotation. The repo now prefers new secret-key paths where available, but legacy rotation/revocation is not complete from this environment. |
| Build gates | PASS | Latest reruns after browser-lifecycle work: `npm run lint`, root/backend/core typechecks, `deno check supabase/functions/_shared/supabase.ts`, targeted `node --check` commands for the changed E2E harness files, and `git diff --check` all passed. |
| 20-season soak proof | PASS | Commit history records a 20-season all-enabled local Supabase/Fastify/static Expo/fake-upstream run with `Status: PASS`, from `2026-05-13T09:59:24.123Z` to `2026-05-13T12:08:37.866Z`. The current `tests/e2e-report.md` was refreshed by a focused D.SET.2 browser lifecycle run. |
| D.SET.2 create/join lifecycle | PASS | `E2E_ENABLE_LEAGUE_LIFECYCLE=1 E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1 npm run e2e:soak -- --seasons=1` passed on local Supabase/static Expo. The report now records both the 10-user auth/RPC lifecycle and the real Expo create/join form lifecycle, with D.SET.2 marked PASS in `tests/e2e-coverage.md`. |
| D.X.2 score realtime | PASS | The 20-season proof includes 10-client matchup realtime checks. |
| D.X.1 push notifications | PASS | The 20-season proof enabled both fake Expo push intercept modes and captured trade, waiver, and rookie auto-pick draft notifications. |
| D.X.2 auction bid realtime | PARTIAL | `20260513000001_enable_draft_realtime.sql` and the updated soak runner prove auction bid nomination realtime in a focused local Supabase run with 10 clients: matchup max latency 88 ms, bid max latency 510 ms. A full 20-season rerun with this new slice is pending. |
| Remote Supabase draft realtime migration | BLOCKED | Latest retry of `supabase db push --linked --dry-run` still failed while creating a temporary login role: Postgres connection timeout, with the CLI asking for `SUPABASE_DB_PASSWORD`. The migration is applied locally but not verified on the linked remote project. |
| Prompt-to-artifact coverage | PARTIAL | `tests/e2e-coverage.md` still marks multiple original prompt rows as `PARTIAL` because the proof uses focused browser/backend slices rather than one literal monolithic 10-user browser workflow for every listed weekly action. |
| Final production-ready exit criteria | FAIL | The blocker list above prevents marking the high-level goal complete. |

## Current Blockers

1. Set hosted Fastify/Railway admin env to a full `PANCAKE_SUPABASE_SECRET_KEY` or `SUPABASE_SECRET_KEY`.
2. Rotate/revoke the legacy Supabase JWT/service-role credential through the Supabase Dashboard flow.
3. Push `20260513000001_enable_draft_realtime.sql` to the linked Supabase project once remote Postgres connectivity is healthy.
4. Rerun the 20-season all-enabled soak after the remote migration and hosted env are in place, including `E2E_ENABLE_BROWSER_LEAGUE_LIFECYCLE=1`.
5. Decide whether the remaining focused-slice coverage rows are acceptable evidence or require a literal monolithic 10-user browser workflow.
