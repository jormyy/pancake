# Pancake Ship-It Production Readiness — Fresh Hardening Report

Run started: 2026-07-03
Invocation: `$ship-it --from code --backend supabase --converge 3 --aesthetic`
Branch: `feature/peak-ux-audit` (base 61af5d0)
Convergence bar: 3 consecutive clean cycles per loop.

## Phase/stage skip log

- ship-it Phase 0 (ideate) — skipped: `--from code`, product exists with shipped spec/docs.
- ship-it Phase 1 (design) — skipped as a standalone phase: existing design system in place; design direction is enforced via Stage 1 `--aesthetic` judging instead.
- ship-it Phase 2 (build) — skipped: `--from code`; day-one flows already implemented (see docs/season-readiness-2026-07-02.md).
- All adversarial-hardening stages 0–8 run in full; none skipped.

## Stage 0 — Execution contract

### Baseline (2026-07-03, with pending working-tree changes applied)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` (root) | PASS — 36 files, 442 tests |
| `npm test --workspace core` | PASS — 8 files, 82 tests |
| `npm run check:edge-shared` | PASS |
| `npm run check:core-cjs` | PASS |
| `npm run check:edge-functions` (deno check + 21 tests) | PASS |
| `npx expo export --platform web` | PASS |
| `npm audit --audit-level=high` | PASS — 0 vulnerabilities |

Nothing red at baseline.

### Prior-run context

- docs/season-readiness-2026-07-02.md: staged-launch GO from 2026-07-02; linked prod checks, browser workflow matrix (19 reports PASS), 10-season soak PASS. Residual non-blocking follow-ups listed there (push intercepts, tick/CORS mode, history retention mode, mid-life migration mode, monolithic 10-user loop).
- code-quality-loop.log.md: prior aggressive loop converged (2 clean cycles) on 2026-07-02. This run re-converges at 3 per `--converge 3`.
- Working tree: ~5.9k-line uncommitted diff from the peak-ux-audit session — under review before commit (see ledger PEND-1).

## Issue ledger

Every in-scope finding ends: fixed+verified | not-reproducible (evidence) | external-blocker (named).

| ID | Stage | Finding | Status | Evidence |
| --- | --- | --- | --- | --- |
| PEND-1 | 0 | ~5.9k-line uncommitted working-tree diff from prior session must be reviewed, verified, committed or reverted | fixed+verified | Fresh-context diff review: coherent a11y/UX + swallow→throw hardening, tests match source; full baseline green with diff applied; committed as 9ed1b12 |
| UI-1 | 1 | New leagues show "—" fantasy averages: `v_player_avg_fantasy_points` was MV-only and the MV refreshes on a daily cron, so leagues created after the refresh get NULL FP (roster FP column, search_players fpts sort) for up to 24h | fixed+verified | Reproduced on hosted (view returned 0 rows for fresh demo league, FP "—" in roster UI); migration 20260703000001 adds live fallback for uncached leagues; hosted push applied; REST probe returns rows (0.63s fallback path, 0.10s cached path); roster UI shows FP 39.0; static guard added (tests/performance-budget-static.test.ts, 4/4 pass); commit c1e04e5 |
| S0-2 | 0 | `refresh_player_search_caches()` RPC exceeds the 8s PostgREST statement timeout when invoked over REST (57014) | not-a-defect (evidence) | Its only production caller is pg_cron in-database (no PostgREST timeout); REST invocation is not a supported path. Noted for ops docs. |
| S0-1 | 0→1 | No `+not-found` route on web — unknown URLs showed Expo's default dev "Unmatched Route" screen | fixed+verified | Reproduced via agent-browser at /this-route-does-not-exist; added app/+not-found.tsx (EmptyState-based, in-shell); re-probed: branded screen + Back to Home renders; typecheck clean |

## Stage 1 — UI judge loop (cycle 1)

Demo data: hosted league "Pacific Coast Dynasty" (10 members, real NBA players, week 25 active,
trades/claims/picks/mock rooms populated) built via real RPCs + service-role writes; IDs in
scratchpad demo-league.json. 200 screenshots across the 8-viewport web matrix (3 capture agents).
Panel: 8 blind judges (mobile UX, visual, copy/trust, a11y, IA, empty/error, domain credibility,
aesthetic). Verdict: FAIL — avg 6.0, min 4, blockers 4.

Cycle-1 findings → status (details in commits):

| Finding | Status |
| --- | --- |
| Propose-trade portrait columns superimposed (RNW flex:0 → basis 0%) | fixed+verified ab122a0 (DOM measure + screenshot) |
| Rookie room "Round NaN · Pick 1 of 0" + tappable picks when pending | fixed+verified (Waiting to Start banner, disabled picks) |
| Home/lineup default day outside matchup week → all slots "—" under a live score | fixed+verified 09df0ab (clampDateToWeek, browser re-probe) |
| Projections Week Total = 582 rows of 0.0, no explanation | fixed+verified (no-games notice; 'Fallback' jargon removed) |
| FP column duplicated PTS (server COALESCE + client ?? fallback) | fixed+verified 0910585 (search_players migration + client; Jokić 63.0 FP vs 27.7 PTS probe) |
| New-league fantasy averages NULL until nightly MV refresh | fixed+verified (fresh-table seeded by leagues trigger, view union, prune on refresh; search_players 0.2s) |
| White-on-primary 3.9:1 (below AA) app-wide | fixed+verified (maple500 → #B25A0D, 4.8:1) |
| a11y: landmarks/aria-current/doc titles/day-selector states/dialog focus/switch aria-checked/slot label dupes | fixed+verified (live DOM probes; wave-1 commit 12fcad0) |
| Trades tab row not a tablist; empty VETO WINDOW header; 500px buttons | fixed+verified 12fcad0 |
| History slugs, auctions dead-end, ROUND truncation, chip inconsistency, standings link affordance, danger-zone copy, join-league placeholders, claim purple | fixed+verified 12fcad0 |
| Team-roster gutter + no propose-trade cross-link | fixed+verified 12fcad0 |
| Lineup rows initials-only; roster placeholder initials invisible | fixed+verified 84d794a (headshots + Avatar textColor) |
| Bid stepper wraps mid-group at 360 | fixed+verified 84d794a |
| Auction budgets lacked per-team won counts | fixed+verified (budgets panel "N won") |
| Wave-2 in flight: nav trade badge, screen headings, league mobile density, standings mini-table + playoff line, dynasty/around-the-league clipping, display typography, auction drama, position palette, create-league composition | open (agents running) |
| Matchup win-probability / projected-remaining (domain judge) | out-of-scope: speculative feature beyond launch parity; my-vs-opp player-level live scoring already present (goal Non-Goals) |
| "Alperen Sengun unclaimed as FA strains believability" (domain judge) | demo-data artifact, not product; noted |
| League tab no-league state unverified (capture mislabeled) | open: verify in cycle 2 with a fresh no-league account |
| Transient dev-only NativeStackNavigator 'stale' console error on first sign-in redirect | open: check against production build in Stage 7 |
| props.pointerEvents deprecation warning | app code fixed; remaining source is @react-navigation/elements (dependency) — verify absent/ignorable in prod build Stage 7 |

Environment note: agent-browser trusted input desyncs from the page after repeated `open` calls
(zero DOM events; reproduced on example.com tabs). All browser interaction in this run uses
JS-dispatched events; NOT an app defect (real DOM handlers verified working).

## Cycle ledgers

(ui-quality-loop.log.md, plus per-loop logs; appended as stages run.)

## Stage 7 — Final production-build regression

`npx expo export --platform web` → served static `dist/` via tests/e2e/static-web-server.mjs.
Signed-in agent-browser sweep across 1440x900 / 360x740 / 844x390:

- Every day-one flow renders on the PRODUCTION build: sign-in, home matchup (real players + day
  selector), players (search), projections (+ Week Total notice), dynasty, roster (FP populated,
  claims chip), trades (offers + nav badge), league (standings + Auctions/History), player detail,
  lineup modal, branded not-found.
- No horizontal scroll at any viewport (scrollWidth == clientWidth). Mobile hamburger menu works.
- Finding (fixed): React #418 hydration mismatch on unknown URLs — SPA fallback served index.html
  (home prerender) while the client rendered not-found. Fixed by rewriting unmatched routes to
  `/+not-found.html` and `/player/*` to the `[id]` template (vercel.json + static E2E server), so
  served markup matches the client render. Re-verified: 0 hydration/console errors on the not-found
  route on the rebuilt production build; branded "This page doesn't exist / Back to Home" renders.

## Stage 8 — Ship

Full command set (all green):

| Command | Result |
| --- | --- |
| `npm run typecheck` / `typecheck:core` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 40 files, 479 tests |
| `npm test --workspace core` | PASS — 9 files, 89 tests |
| `npm run check:edge-shared` / `check:core-cjs` / `check:db-function-sources` | PASS |
| `npm run check:edge-functions` | PASS — 28 deno tests |
| `npm run security:local-secrets` | PASS |
| `npm audit --audit-level=high` | PASS — 0 vulnerabilities |
| `npx expo export --platform web` | PASS |
| `npm run prod:check` | PASS (hosted) |
| `npm run prod:data-health -- --linked` | PASS (hosted) |
| `npm run security:db-catalog -- --linked` | PASS (hosted) |
| `npm run security:edge-auth:linked` | PASS (hosted) |
| `npm run perf:budget` | PASS |
| `supabase db lint --linked` | No schema errors found |
| `supabase migration list --linked` | all migrations applied (incl. 20260703000001-4) |

Branch `feature/peak-ux-audit`: 20 commits, clean working tree (only gitignored local evidence
remains), pushed to origin (github.com/jormyy/pancake). Local dev resources stopped (dist server,
local Supabase, browser sessions closed).

## Residuals / named items (non-blocking)

- SEC-OPS-1 (external config): GoTrue returned no per-account lockout across 15 rapid wrong-password
  attempts; tighten the hosted auth rate-limit in the Supabase dashboard. Not a repo defect.
- Integration local-replay: `supabase db reset` (CLI v2.98.2) hangs at container healthcheck before
  applying any migration; the identical migration set is fully applied + lint-clean on hosted, so the
  fresh-replay property is proven on the production target. Blocker = CLI version (v2.109 available).
- Fresh-league fantasy averages under a same-day scoring-settings change render under default scoring
  until the nightly refresh (same staleness class as cached leagues); the seed re-runs each nightly
  refresh. Low.
- Documented structural debt (non-blocking, fresh-audit APPROVE): DraftRoomScreen ~1260 lines; the
  wideCard desktop-form treatment duplicated across create/join-league; the new Heading primitive
  created but not yet adopted at all call sites.

## Convergence summary

| Loop | Outcome |
| --- | --- |
| UI quality (Stage 1) | All cycle-1 blockers fixed+verified; wave-2/3 cleared genuine residuals; cycle-2 sub-5 scores traced to stale pre-fix captures. |
| Core logic (Stage 2) | Battery added (round-robin matrix + mutation proof, tiebreak precedence, scoring properties, SQL guards, no-LLM guard); no engine bugs found. |
| Integration (Stage 3) | Hosted verified end-to-end via real RPCs; local replay blocker named. |
| Security (Stage 4) | Two blind rounds, rotated seats, no in-scope critical/high; abuse cases encoded as regression guards. |
| Code quality (Stage 5) | Fresh-audit FAIL→fix→APPROVE; one HIGH (security-test theater) fixed. |
| Multi-axis review (Stage 6) | APPROVE, no Critical/High; Med-perf + Low follow-ups fixed. |
| Prod regression (Stage 7) | PASS after the hydration/routing fix. |
