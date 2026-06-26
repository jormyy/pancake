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
| L-01 | logic | **High** | BBRef historical backfill (2003-2019) | Scraper ingested **every** game with a box-score link across Oct–Jun — playoff (Apr–Jun) and All-Star (Feb) games included. Their date-keyed IDs (`200406150DET`) bypass `is_regular_season_game_id` (returns true for non-`00\d` prefixes by design), so postseason/All-Star counted as regular season in averages, `v_fantasy_points`, projections, dynasty value. | `backend/src/lib/bbref.ts:71` + `supabase/functions/_shared/bbref.ts:79` had no season-type filter; migration `20260626000002` comment confirms BBRef IDs "remain countable." | **fixed+verified** — `parseBBRefScheduleHtml` now stops at the "Playoffs" divider (global, chronological) and drops All-Star/exhibition matchups (both sides non-franchise), mirrored in both Node+Deno paths. Oracle: `backend/tests/bbref-schedule.test.ts` (9 cases). Backend typecheck✅, deno check✅, 78 backend tests✅. _Note: prod data check deferred to Integration gate (Stage 3) — by-ID cleanup not possible, will re-derive if rows exist._ |

### Findings discovered, queued for their gate (each will end fixed+verified / not-reproducible / external-blocker — no defer)
- **L-02** (logic): scoring rounding divergence — TS `.toFixed(2)` vs SQL `compute_fantasy_points`/`v_fantasy_points` unrounded.
- **L-03** (logic): TS matchup scorer (`backend/src/sync/scores.ts`) lacks the `is_regular_season_game_id` filter the SQL fn/view have (defense-in-depth; current season only).
- **L-04** (logic): week-numbering — 3 schemes (NBA-official live / 7-day historical / variable Week-1 core fallback) with different anchors.
- **L-05** (logic/tz): pg_cron "ET" times hardcode UTC-4 (no DST) → jobs fire 1h late Nov–Mar (the NBA season).
- **S-01** (security): `/notify/trade` lets any member push attacker-controlled title/body to any league member (`backend/src/routes/notifications.ts:8`).
- **S-02** (security): `sync_jobs_select USING (true)` exposes internal job metadata/error_log to all authenticated users (`20260328000004:156`).
- **S-03** (security): CORS `origin: true` reflects any origin (`backend/src/app.ts:20`).
- **S-04** (security): `activate_rookie_draft_league_atomic` member-gated, not commissioner-gated (`20260606000016:24`).
- **S-05** (security): verify `cancel_waiver_claim_atomic` enforces caller→member ownership (route does no ownership check, `backend/src/routes/waivers.ts:111`).
- **U-01** (ui/design): token drift — ~150 fontSize, 41 borderRadius, 34 fontWeight-string, ~195 spacing literals + hardcoded hex; no motion/shadow/scrim tokens.
- **U-02** (ui/code): dead Expo-template theming subsystem (collapsible/themed-text/themed-view/icon-symbol/haptic-tab/use-theme-color/theme.ts) duplicates `tokens.ts`.
- **U-03** (ui/feature, locked decision): startup auction missing nomination-order modes + withdraw-nomination; bid field snaps to minBid on clear.
- **U-04** (ui): duplicate components (4+ pill/badge, 7+ ad-hoc bottom-sheets, 2 LeagueSwitchers).
- **P-01** (pwa): no manifest, service worker, or offline shell.
- **D-01** (exposure): dead backend code (`startFullHistoricalBackfill`, `syncCurrentDraftOrderIfDue`, `tomorrowET`).

---

## Skipped / not-applicable stages (logged so a silent skip never reads as "covered")

| Stage | Reason |
|---|---|
| _none yet_ | |
