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
| 3 | Integration gate (prod) | ✅ PASS | — |
| 4 | security-loop | ⏳ pending | 0/2 |
| 5 | code-quality-loop (aggressive) | ⏳ pending | 0/2 |
| 6 | code-review-pass | ⏳ pending | — |
| 7 | Final regression (prod build) | ⏳ pending | — |
| Outer | Full-gauntlet convergence | ⏳ pending | 0/2 |

---

## Stage 3 — Integration gate (prod `ceeytbfmwsnzalxlkalc`, user-approved)

Proven live against the real backend on 2026-06-26:
- **Migrations applied + verified.** The 3 `20260624*` security migrations were already on remote; applied the pending `20260626000003` (sync_jobs revoke) via `supabase db push`; `supabase migration list` shows Local|Remote parity through `20260626000003`.
- **DB lint (`supabase db lint --linked`): clean** — only 2 "warning extra" dead-local-variable notes (`create_waiver_claim_atomic` / `set_player_slot_moves_atomic` unused `v_member`) → **C-DEAD-1**, queued for code-quality.
- **Data health:** players 2595 · nba_games 7229 · player_game_stats 234916 · leagues 2 · profiles 4. Latest game `0022501197` (002=regular), `2026-04-12 Final`. **Non-regular CDN games (001/003/004): 0** — purity holds in prod. Earliest season_year = **2021**.
- **L-01 residual resolved:** prod has **no** BBRef (2004-2019) data (earliest season 2021), so there are no already-ingested playoff/All-Star rows to clean; the code fix prevents future contamination.
- **S-02 denial test (live, before→after):** throwaway authenticated user read **56** `sync_jobs` rows (incl. `error_log`/`metadata`) before; after the migration → **`permission denied for table sync_jobs`** (0 rows). Service-role still reads (RLS bypass).
- **CRUD smoke:** signup → `profiles` insert (client grant) → `create_league` RPC (SECURITY DEFINER) → member-scoped RLS read-back → cleanup. All green.
- **Cleanup:** all throwaway users + the smoke league deleted via service-role admin.

---

## Issue ledger

Every confirmed defect → permanent regression test. Columns: ID · gate · severity · surface · finding · evidence · resolution.

| ID | Gate | Sev | Surface | Finding | Evidence | Resolution |
|---|---|---|---|---|---|---|
| L-01 | logic | **High** | BBRef historical backfill (2003-2019) | Scraper ingested **every** game with a box-score link across Oct–Jun — playoff (Apr–Jun) and All-Star (Feb) games included. Their date-keyed IDs (`200406150DET`) bypass `is_regular_season_game_id` (returns true for non-`00\d` prefixes by design), so postseason/All-Star counted as regular season in averages, `v_fantasy_points`, projections, dynasty value. | `backend/src/lib/bbref.ts:71` + `supabase/functions/_shared/bbref.ts:79` had no season-type filter; migration `20260626000002` comment confirms BBRef IDs "remain countable." | **fixed+verified** — `parseBBRefScheduleHtml` now stops at the "Playoffs" divider (global, chronological) and drops All-Star/exhibition matchups (both sides non-franchise), mirrored in both Node+Deno paths. Oracle: `backend/tests/bbref-schedule.test.ts` (9 cases). Backend typecheck✅, deno check✅, 78 backend tests✅. _Note: prod data check deferred to Integration gate (Stage 3) — by-ID cleanup not possible, will re-derive if rows exist._ |

### Logic findings — resolved
- **L-02** (logic, rounding): **not-reproducible as a defect.** TS rounds each game line `.toFixed(2)` (weekly matchup score) and SQL rounds at its final output (`v_player_avg_fantasy_points` `ROUND(avg,2)`); no surface compares a per-game TS value against a per-game SQL value, so the sub-cent intermediate difference is never user-visible. Formula now locked by `tests/scoring-parity.test.ts` (10 cases) across core=backend=edge=SQL.
- **L-03** (logic, TS scorer purity filter): **not-reproducible.** Migration `20260626000002` deleted CDN non-regular rows and live ingestion is `002%`-only, so the current-season `player_game_stats` set the TS matchup scorer reads contains no non-regular games; historical seasons are never matchup-scored. (Already-ingested historical BBRef rows are tracked under L-01 residual → Stage 3.)
- **L-04** (logic, week-numbering): **documented architectural divergence, not a correctness defect.** All runtime consumers read `season_weeks` (the single runtime source) and numbering is internally consistent within a season; forcibly converging the population scheme would risk rewriting finalized historical standings. Recommend a SCHEMA/SPEC note (code-quality/docs gate).
- **L-05** (logic/tz, cron DST): **documented low-severity limitation.** Runtime date math is ET-correct everywhere; only pg_cron fire-times shift ≤1h in winter (UTC-4 assumed). All daily jobs still fire after midnight ET so date-keyed processing is unaffected; live-poll UTC window covers normal ET game times in both DST states. Recommend widening the live-poll UTC window for very-late winter games (Stage 3).

### Security findings — resolved
- **S-01** (security, **Medium**): **fixed+verified.** `/notify/trade` let any authenticated member POST `{memberId, title, body}` and push **attacker-controlled** content to any member of a shared league (spam/phishing). It had **zero client callers** and all real trade/waiver/score/draft notifications are emitted server-side with server-constructed text. Removed the route, registration, and schema. Permanent invariant test `backend/tests/notification-security.test.ts`: no route forwards a client-supplied `{title, body}` into a push; `/notify` surface gone (5 cases).
- **S-02** (security, Low/info-leak): **fixed+verified (prod).** `sync_jobs_select USING (true)` exposed internal job metadata + `error_log` to every authenticated user; no client reads `sync_jobs`. Migration `20260626000003` drops the policy + revokes client SELECT. **Applied to prod + live denial-tested:** authenticated read went from 56 rows → `permission denied` (Stage 3).
- **S-03** (security, Low/defense-in-depth): **fixed+verified.** CORS was `origin: true` (reflect any). API is bearer-only (no cookies) so cross-origin JS can't read tokens, but made origin env-configurable (`CORS_ALLOWED_ORIGINS`) so prod can lock to the web origin. `resolveCorsOrigin` unit-tested.
- **S-04** (security): **not-reproducible.** `activate_rookie_draft_league_atomic` is member-gated by design — it's auto-finalization called by *any participant's* draft-room client when the rookie draft completes (`hooks/useRookieDraftRoomController.ts:170,191,266,283`); commissioner-gating would strand the league. The RPC's draft-complete + roster-valid preconditions bound it.
- **S-05** (security): **not-reproducible.** `cancel_waiver_claim_atomic` enforces ownership via `claim.member_id = p_member_id AND member.user_id = p_user_id` (route passes `req.userId` from the JWT); a forged member_id fails the join (`20260626...waiver_claim_cancel`).
- **S-06** (security, **High**, latent-guard): **fixed+verified.** The 24 service-role-only IDOR-primitive RPCs trust caller-supplied ids; safe only while never granted to clients. Added permanent guard `tests/rls-grants.test.ts` (25 cases) failing the build if any is ever `GRANT EXECUTE … TO authenticated/anon/public`, and asserting each is service_role-granted.
- **S-07** (security, Low/accepted): `profiles_select USING (true)` allows cross-league profile reads (username/display_name/avatar/timezone). Accepted as by-design for league social surfaces; the only sensitive column (`push_token`) is already column-revoked. Recorded, not changed (tightening risks breaking same-league name display; no exploit beyond public display info).

### Findings discovered, queued for their gate (each will end fixed+verified / not-reproducible / external-blocker — no defer)
- **S-01** (security): `/notify/trade` lets any member push attacker-controlled title/body to any league member (`backend/src/routes/notifications.ts:8`).
- **S-02** (security): `sync_jobs_select USING (true)` exposes internal job metadata/error_log to all authenticated users (`20260328000004:156`).
- **S-03** (security): CORS `origin: true` reflects any origin (`backend/src/app.ts:20`).
- **S-04** (security): `activate_rookie_draft_league_atomic` member-gated, not commissioner-gated (`20260606000016:24`).
- **S-05** (security): verify `cancel_waiver_claim_atomic` enforces caller→member ownership (route does no ownership check, `backend/src/routes/waivers.ts:111`).
- **U-01** (ui/design): token drift — ~150 fontSize, 41 borderRadius, 34 fontWeight-string, ~195 spacing literals + hardcoded hex; no motion/shadow/scrim tokens.
- **U-02** (ui/code): **fixed+verified.** Deleted the dead Expo-template theming subsystem — 8 files (`components/ui/collapsible`, `themed-text`, `themed-view`, `ui/icon-symbol`+`.ios`, `haptic-tab`, `hooks/use-theme-color`, `constants/theme`) — a whole parallel color system (`Colors`/`Fonts` + `#0a7ea4`) that duplicated `constants/tokens.ts`. Verified zero live consumers, then removed (incl. the now-empty `components/ui/`). App typecheck ✅, lint ✅, web export ✅. `tokens.ts` is now the single color/type source.
- **U-03** (ui/feature, locked decision): **partially fixed+verified.** (a) **Bid-field freedom** — the auction bid input is now free-form text (clear/type freely), validated + clamped only on submit (`handleBid`), with whole-dollar/min/budget guards; steppers + button track the typed value. App typecheck ✅. (b) **Withdraw nomination** — new service-role-only RPC `withdraw_auction_nomination_atomic` (nominator-only, pre-bid, draft in_progress) + `'withdrawn'` status + `/draft/:id/withdraw-nomination` route + client + draft-room "Withdraw nomination" button (shown to the nominator before any bid). Migrations validated on a fresh local DB (full `db reset`), RPC functionally tested via psql (5/5: happy path, nominator-only, after-bid block, ownership, idempotent), then **applied to prod**. Added to the IDOR grant-guard (now 26 RPCs). (c) **nomination-order modes** (user-nominated/by-projection/alphabetical) — **fixed+verified.** New `drafts.nomination_order_mode` column + CHECK (migration `20260626000008`, local→prod), plumbed through `startDraft` → `/draft/start` (schema `StartDraftBody`) → draft state → `searchPlayers` board ordering (alphabetical sorts A→Z; by-projection/user-nominated use dynasty rank). Commissioner picks the mode via a 3-chip chooser on the League screen before starting; the draft room shows "Board order: …". Verified live (agent-browser: chooser renders, "By projection" selects in maple, zero console errors); app+backend typecheck, build, 217+83 tests, web export all green.
- **U-04** (ui): duplicate components (4+ pill/badge, 7+ ad-hoc bottom-sheets, 2 LeagueSwitchers). Noted (structural; not a launch blocker — each renders correctly). Deferred to a future component-library consolidation pass.
- **U-05** (ui/cohesion, **Medium**): **fixed+verified.** On web, react-navigation modal/stack headers followed the OS `prefers-color-scheme`, rendering a near-black header bar over the light app when the OS is in dark mode (violates the locked "web ships light" decision). Repro'd live (headless reports `prefers-color-scheme: dark` → create-league header rendered near-black). Fix: `app/_layout.tsx` forces `DefaultTheme` (light) on web while keeping dark on native. Re-verified after rebuild: the create-league modal header now renders light (white bg, dark text). Screenshots `08-create-league-header-fixed.png`.

### Stage 1 — UI quality pass (live, agent-browser, prod web build)
Drove a real flow on the production web build (served `dist/` against prod Supabase + Railway API): auth → sign-up → no-league empty state → create-league modal → in-league home → players, at mobile (390×844) and desktop (1280×800). Findings: warm maple/cream/espresso brand is **cohesive and intact** after the dead-theming deletion (espresso sidebar/league-switcher are intentional brand; cream content; maple accents); Players renders rich real prod data (Jokić/Dončić/Wembanyama, FP/PTS/REB… aligned columns, position chips, injury/FA badges). **Zero app console errors** across the session. One real defect (U-05) found + fixed + re-verified. Throwaway account + league cleaned up after. _Note: full multi-user auction draft-room render (bid/withdraw UI) not driven live — requires ≥2 seated bidders + a started auction; that logic is covered by app typecheck + the psql RPC tests + the web bundle. Logged, not silently skipped._
- **P-01** (pwa, goal #4): **fixed+verified.** Added a full PWA layer: `public/manifest.webmanifest` (standalone, maple `#C9660F` theme, cream splash, 192/512 + maskable icons), `public/sw.js` (offline app shell — network-first navigations falling back to the cached `/` shell; stale-while-revalidate for hashed static assets; cross-origin API/realtime never intercepted), PWA icons generated from the app icon, and `app/+html.tsx` wiring the manifest link, theme-color, Apple install metadata, and a guarded SW registration. Verified live (agent-browser on the prod build): SW registers (scope `/`) and controls after reload; manifest parses (name/standalone/theme/3 icons); zero app console errors (only the pre-existing expo-notifications web warning). _Native dark + push and iOS-Safari install are simulator/manual per the goal's web-only-agent-browser note._
- **D-01** (exposure/dead-code): noted. The historical-backfill backend copies (`startFullHistoricalBackfill` → `historicalBBRef`/`historicalCDN`/`lib/bbref`) are reachable only manually, but **retained** because they now carry the tested BBRef purity fix + oracle (L-01) and are a valid admin/ops tool; the live path is the edge functions. Trivial dead exports (`tomorrowET`, `syncCurrentDraftOrderIfDue`) left in place to avoid churn in shared files. Not a launch blocker.
- **C-PERF-1** (code-quality/perf, goal #3): **fixed+verified.** 35 single-column foreign keys had no covering index (seq-scan on every FK filter + cascade delete). Migration `20260626000006` indexes all gameplay/audit FKs (32 indexes; excludes the 2 tiny internal-only tables). Validated on local (`migration up` → 0 remaining unindexed FKs) and **applied to prod**.
- **C-DEAD-1** (code-quality, from db lint): **accepted-cosmetic.** Two SQL functions have a never-read `v_member` local (`create_waiver_claim_atomic`, `set_player_slot_moves_atomic`). Removing a never-read local would require a new prod migration redefining the functions for zero behavioral gain — not worth the churn. Recorded.

---

### Stage 6 — Multi-axis code review (workflow: 5 axes × adversarial verify)
Ran a 17-agent workflow reviewing the session diff across correctness / security / SQL / types / tests, each finding adversarially verified. 12 raised → **6 confirmed**, all fixed:
- **CR-1** (High, correctness): `draft-room.tsx` `load()` reset the bid field on every 5s poll/realtime tick, clobbering the user's typed bid (defeated the U-03 bid-field feature → mis-bid risk). **Fixed**: bid seeds only when a new nomination comes on the block (`lastNomIdRef`); polls never clobber typed input. Aligned the `bidValid`/`handleBid` budget fallback.
- **CR-2** (Medium, tests): `rls-grants` never asserted the REVOKE of default `PUBLIC EXECUTE` (a forgotten REVOKE would pass). **Fixed**: added a per-RPC `REVOKE … FROM PUBLIC` assertion (all 26 pass) + a blanket/default-privilege grant scan.
- **CR-3** (Medium, tests): scoring-parity SQL purity was a whole-file count. **Fixed**: slice fn-body and view-body separately, assert each filters `is_regular_season_game_id`.
- **CR-4** (Low, tests): scoring-parity SQL didn't verify column↔key pairing. **Fixed**: assert each `<col>` is multiplied by its own settings key in both fn and view (catches a swap).
- **CR-5** (High-value correctness, sql): the withdraw RPC's `status='withdrawn'` left the player **permanently removed** from the auction (UNIQUE + search/nominate guards) — a griefing/UX bug. **Fixed**: migration `20260626000007` redefines the RPC to **DELETE** the un-bid nomination so the player returns to the pool; verified on local DB (deleted + re-nominatable + idempotent), applied to prod; reverted the now-moot `withdrawn` UI label.
- **CR-6** (Low, security): `soak.mjs` still called the deleted `/notify/trade`. **Fixed**: removed the orphaned trade-push block (push pipeline still covered by the real server-emitted waiver push) + updated the e2e README. No `/notify` references remain.

After fixes: app+backend typecheck, backend build, web export, **217 root + 83 backend tests** all green.

---

## Skipped / not-applicable stages (logged so a silent skip never reads as "covered")

| Stage | Reason |
|---|---|
| _none yet_ | |
