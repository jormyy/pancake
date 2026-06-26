# Pancake — Fresh Hardening Report

_Launch-readiness adversarial gauntlet · branch `codex/annual-draft-sync` · runs against **production** (dev-stage, mutable)._

Single source of truth for the issue ledger. Driven by `adversarial-hardening` (Design → Build → Harden → Verify → Ship), wrapped in one outer convergence loop (ship only after 2 consecutive fully-clean gauntlet passes). No-defer: every in-scope finding ends `fixed+verified`, `not-reproducible` (with evidence), or `external-blocker` (named credential/setup).

---

## Stage 0 — Execution contract (baseline)

**Date:** 2026-06-26 · **Base commit:** `5d18912` (fix: exclude non-regular nba games)

### Dirty-state reconciliation
The branch's uncommitted changes + untracked files are **coherent hardening WIP** (not stale artifacts), aligned with the recent `annual-draft-sync` commits:
- `backend/src/sync/verify.ts` — wrap every Supabase query in `assertSupabaseOk()` so verify tooling throws on silent query failure instead of reporting false-clean.
- `backend/tests/verify.test.ts` (new) — regression tests proving verify throws on errored queries.
- `backend/src/types/database.ts` — add `dynasty_rank_source` / `dynasty_rank_fetched_at` columns.
- `lib/supabase.ts`, `lib/shared/api.ts` — dev-only (`NODE_ENV !== production`) URL-query-param config overrides for e2e harness.
- `supabase/migrations/20260624000001_revoke_broad_client_mutation_grants.sql` — revoke broad anon/authenticated table mutation grants; restrict client writes to profiles + team_name.
- `supabase/migrations/20260624000002_enable_rls_internal_tables.sql` — enable RLS on `backfill_game_attempts`, `trade_drop_reservations`.
- `supabase/migrations/20260624000003_dynasty_rank_source_timestamps.sql` — dynasty rank provenance columns + partial index.
- `tests/e2e/*.mjs`, `tests/e2e/env.mjs` — e2e harness updates (runtime override params).
- `scripts/prod-cleanup-*.mjs` — synthetic-row cleanup utilities.

**Decision:** commit as the Stage 0 baseline so the working tree is clean for the gauntlet. **Removed** stale artifact `criticality-loop.log.md` (prior run's log).

### Baseline gate results (with WIP applied)
| Gate | Command | Result |
|---|---|---|
| typecheck (app) | `npm run typecheck` | ✅ PASS |
| typecheck (backend) | `npm run typecheck:backend` | ✅ PASS |
| typecheck (core) | `npm run typecheck:core` | ✅ PASS |
| lint | `npm run lint` | ✅ PASS |
| test (root) | `npm test` | ✅ 154 passed |
| test (backend) | `npm test --workspace backend` | ✅ 69 passed |
| test (core) | `npm test --workspace core` | ✅ 72 passed |
| build (backend) | `npm run build:backend` | ✅ PASS |
| build (web) | `npx expo export --platform web` | ✅ PASS (4.8M dist, all routes exported) |
| audit | `npm audit --audit-level=high` | ✅ 0 vulnerabilities |

**Baseline = fully green.** No pre-existing red. Any new failure during the gauntlet is a regression.

---

## Stage status tracker

| Stage | Loop | Status | Streak |
|---|---|---|---|
| 0 | Execution contract | ✅ baseline green | — |
| D1 | Backend-exposure audit | ⏳ pending | — |
| D2 | Competitive parity (Fantrax/Sleeper) | ⏳ pending | — |
| Design | Unified token system | ⏳ pending | — |
| Build | Discovery wire-up + QOL + auth + cohesion + perf + PWA | ⏳ pending | — |
| 1 | ui-quality-loop | ⏳ pending | 0/2 |
| 2 | logic-hardening-loop | ⏳ pending | 0/2 |
| 3 | Integration gate (prod) | ⏳ pending | — |
| 4 | security-loop | ⏳ pending | 0/2 |
| 5 | code-quality-loop (aggressive) | ⏳ pending | 0/2 |
| 6 | code-review-pass | ⏳ pending | — |
| 7 | Final regression (prod build) | ⏳ pending | — |
| Outer | Full-gauntlet convergence | ⏳ pending | 0/2 |

---

## Issue ledger

Every confirmed defect → permanent regression test. Columns: ID · gate · severity · surface · finding · evidence · resolution.

| ID | Gate | Sev | Surface | Finding | Evidence | Resolution |
|---|---|---|---|---|---|---|
| _none yet_ | | | | | | |

---

## Skipped / not-applicable stages (logged so a silent skip never reads as "covered")

| Stage | Reason |
|---|---|
| _none yet_ | |
