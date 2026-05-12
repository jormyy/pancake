# Pancake Production Readiness Audit

Date: 2026-05-12
Branch: `refactor/post-cleanup-sweep`
Scope: Phase A read-only audit across frontend, backend, Supabase schema/functions, shared `core/`, build/CI, security, accessibility, and dynasty data integrity.

## Executive Summary

The app is not production-ready yet. The highest-risk blockers are security and dynasty data integrity:

- A Supabase service-role JWT is committed in migration history.
- RLS permits any league member to update/delete any roster row in that league.
- Trade acceptance and draft-pick movement are non-transactional and can partially apply.
- Season reset can leave a league with zero current seasons.
- Backend and Edge scoring/waiver logic have drifted, so production behavior depends on which runtime executes a job.
- Current lint/typecheck/build gates fail locally, and CI would not catch those failures.

Phase B should address every P0/P1 below before any multi-season soak harness work starts.

## P0 Findings

| ID | Location | Category | Finding | Suggested Fix | Effort |
|---|---|---|---|---|---|
| P0-1 | `supabase/migrations/20260327000019_cron_fn_credentials.sql:18` | Security / secret exposure | A Supabase service-role JWT is committed in a migration. A later migration reverts the function source, but the secret remains in repo history and any clone. | Rotate the Supabase JWT/service-role secret immediately, remove the literal from history, invalidate old cron DB settings, and verify no deployed function still uses it. | M |
| P0-2 | `supabase/migrations/20260328000004_rls_policies.sql:181` | Security / RLS | `roster_players_update` and `roster_players_delete` are league-scoped. Any authenticated member of a league can update/delete any roster row in that league. | Remove league-wide roster mutation policies. Restrict direct client mutations to owned rows and move ownership-changing roster moves to backend service-role endpoints or locked `SECURITY DEFINER` RPCs. | L |
| P0-3 | `lib/trades.ts:152`, `lib/trades.ts:178`, `supabase/migrations/20260328000004_rls_policies.sql:278` | Data integrity / trade atomicity | Trade acceptance moves players before pick updates and completion. `draft_picks` only has a SELECT policy, so pick updates can fail after roster moves. Offered/requested pick ownership is not server-validated at accept time. | Move trade accept/reject/withdraw/propose to one backend/RPC transaction that locks the trade, validates all current player/pick owners and league membership, applies all moves, then marks completed. | L |
| P0-4 | `backend/src/app.ts:26`, `backend/src/plugins/auth.ts:33` | Security / backend auth | Fastify registered `authPlugin` as a sibling plugin before route plugins. The hook was encapsulated and did not protect later registered routes; unauthenticated `/sync/*` requests reached handlers. | Install the auth hook on the root Fastify instance, then verify protected routes and E2E-only routes return 401 without credentials. | S |

## P1 Findings

| ID | Location | Category | Finding | Suggested Fix | Effort |
|---|---|---|---|---|---|
| P1-1 | `package.json:57`, `lib/shared/dates.ts:1`, `backend/src/lib/scoring.ts:2`, `supabase/functions/_shared/scoring.ts:1` | Build reproducibility / dead-code residue | Current workspace depends on untracked `core/` and direct `../../../core/src/...` imports. A clean checkout cannot reproduce the current build. | Commit/package `core/` with a clear build boundary, or revert imports to tracked local code. Edge functions should not depend on repo source layout unless deployment bundles it explicitly. | M |
| P1-2 | `lib/roster.ts:4`, `lib/roster.ts:228` | Build / type safety | `isIREligible` is re-exported from `@pancake/core` but not locally imported where it is called, causing `TS2552`. | Import the function locally or call through a named local alias. | S |
| P1-3 | `lib/shared/week.ts:3`, `lib/shared/week.ts:59` | Build / DRY regression | `calculateWeekNumberFromDate` is re-exported but not locally imported before use, causing `TS2304`. | Import locally and export separately, or call through a local alias. | S |
| P1-4 | `supabase/functions/_shared/syncScores.ts:77`, `supabase/functions/_shared/scoring.ts:27`, `backend/src/sync/scores.ts:31` | DRY / scoring correctness | Backend scoring uses ET/date-range `season_weeks`; Edge scoring still uses `week_number` and omits FG/FT fields. Scores can differ by runtime. | Use one canonical scoring implementation via shared package/data adapter, or route scheduled Edge scoring through backend logic. | L |
| P1-5 | `supabase/functions/_shared/scoring.ts:1` | Architecture / dependency boundary | Edge shared code imports `../../../core/src/...` directly. This couples Supabase deployment to repo layout and unbuilt TS source. | Consume built `@pancake/core`, vendor generated shared code, or document and implement an Edge bundle step. | M |
| P1-6 | `backend/src/lib/supabase.ts:7`, `supabase/functions/_shared/supabase.ts:3` | Type safety | Backend and Edge Supabase clients are created without `Database` generics; 300+ `.from()` calls are untyped. | Share/import generated `Database` types and use `createClient<Database>()` in Node and Edge clients. | M |
| P1-7 | `types/database.ts:1305`, `types/database.ts:1306` | Type safety | Generated types have empty `Views` and `Functions`, while code queries views/RPCs. This forces casts and hides schema drift. | Regenerate Supabase types from the actual DB/schema and commit view/function types. | M |
| P1-8 | `lib/trades.ts:39`, `lib/waivers.ts:33`, `lib/players.ts:331`, `lib/rookieDraft.ts:123` | Type safety | App code uses many `(supabase as any)` casts in trade, waiver, roster, player, and draft flows. | Fix generated schema coverage, then remove casts using typed row aliases/query helpers. | L |
| P1-9 | `hooks/use-focus-async-data.ts:31`, `app/(tabs)/league.tsx:38`, `app/(tabs)/roster.tsx:47`, `app/(tabs)/players.tsx:230` | Frontend performance | Focus refresh is eager and uncached; screens issue multi-query reloads and blocking spinners on every focus. | Add stale-while-revalidate/TTL caching keyed by stable IDs; only show blocking loading on first load. | M |
| P1-10 | `hooks/use-auth.ts:10`, `app/_layout.tsx:18`, `contexts/league-context.tsx:19` | Frontend performance | Each `useAuth()` caller creates its own session fetch, auth subscription, and AppState listener. | Create a single `AuthProvider`/external store and make hooks consume shared auth state. | M |
| P1-11 | `hooks/use-live-stats.ts:30`, `app/(tabs)/index.tsx:43`, `app/(modals)/lineup.tsx:186` | Frontend performance | Each consumer starts a 15s live-stat poll, with duplicate lineup refresh paths. | Centralize live stats by date, dedupe in-flight requests, and pause/throttle background polling. | M |
| P1-12 | `backend/src/sync/livePoller.ts:118`, `backend/src/sync/livePoller.ts:129`, `backend/src/sync/livePoller.ts:51` | Backend performance / scheduler | After all games are final, the poller can re-enter active mode during the same window and stack duplicate delayed final-sync timers. | Track per-date finalization state and dedupe delayed final-sync timers. | M |
| P1-13 | `backend/src/sync/livePoller.ts:67`, `backend/src/sync/livePoller.ts:83`, `backend/src/sync/livePoller.ts:102`, `supabase/migrations/20260327000018_cron_jobs.sql:111` | Backend performance / scheduler | Backend poller and Supabase pg_cron can run live sync concurrently with no lease/in-flight guard. | Choose one live-sync owner or wrap jobs in DB advisory locks/leases; add local in-flight guards. | M |
| P1-14 | `backend/src/sync/scores.ts:144`, `backend/src/sync/scores.ts:17`, `backend/src/sync/scores.ts:31`, `backend/src/sync/scores.ts:166` | Backend performance | Score sync recomputes each matchup sequentially with repeated lineup/stat queries and updates. | Fetch matchups, lineups, and stats once per league/week; aggregate in memory; batch update. | L |
| P1-15 | `lib/games.ts:37`, `lib/games.ts:41`, `supabase/migrations/20260328000007_pgs_game_date.sql:36` | Supabase performance | Live stats query by `player_game_stats.game_date`, but existing index leads with `player_id`. | Add `(game_date, player_id)` or `game_date` index and update `SCHEMA.md`. | S |
| P1-16 | `backend/src/plugins/errorHandler.ts:26` | Error handling / disclosure | Backend 500s return raw `error.message`, potentially exposing schema/provider details. | Expose raw messages only for intentional 4xx errors; return generic 500 with request/error ID and log details server-side. | S-M |
| P1-17 | `supabase/functions/sync-scores/index.ts:9` | Error handling / disclosure | Edge functions return `e.message` on 500 across sync/waiver/backfill/verify functions. | Add shared Edge response helper with generic 500s and structured server-side logs. | M |
| P1-18 | `backend/src/index.ts:6` | Reliability / observability | `uncaughtException` and `unhandledRejection` are logged but the process continues. | Log, flush if needed, exit with code 1, and rely on process manager restart. | S |
| P1-19 | `backend/src/sync/seasonReset.ts:36`, `backend/src/sync/seasonReset.ts:43`, `supabase/migrations/20260226000001_initial_schema.sql:167` | Dynasty data integrity | DB enforces at most one current season, not exactly one. Season reset marks old non-current before inserting new without a transaction; failures can leave zero current seasons. | Move season reset into DB transaction/RPC and add invariant checks for exactly one current season per active league. | M |
| P1-20 | `lib/roster.ts:63`, `backend/src/services/roster.ts:29`, `app/(tabs)/roster.tsx:130` | Dynasty business rules | IR/taxi eligibility, caps, and activation roster capacity are enforced mainly in UI handlers; shared mutations can bypass them. | Enforce caps/eligibility server-side via backend/RPC/DB checks; keep UI checks as hints. | M |
| P1-21 | `backend/src/sync/rookieDraft.ts:202` | Dynasty draft-pick integrity | Rookie pick completion marks an arbitrary unused `draft_picks` row by `current_owner_id + round`, not the exact owned asset. Multiple same-round picks can consume the wrong asset. | Add `draft_pick_id` to `snake_draft_picks`, populate during seeding, and mark that exact asset used in the same transaction. | M |
| P1-22 | `supabase/functions/process-waivers/index.ts:96`, `backend/src/sync/waivers.ts:33` | Waiver integrity | Edge waiver processor counts non-IR players but not non-taxi players, unlike backend. Claims are sorted by submitted priority, so one team can win multiple same-day claims after moving to the back. | Use one canonical waiver processor; count active roster as non-IR and non-taxi; recompute/lock priority between claims. | M |
| P1-23 | `lib/waivers.ts:146`, `backend/src/sync/waivers.ts:33`, `supabase/migrations/20260328000004_rls_policies.sql:353` | Security / waiver authority | Client inserts waiver claims and can forge priority/process/drop/status fields allowed by RLS. Processor trusts them. | Submit/cancel waivers through backend/RPC only; server derives priority, process date, season, eligibility, and transitions. | M |
| P1-24 | `lib/trades.ts:82`, `lib/trades.ts:152`, `supabase/migrations/20260328000004_rls_policies.sql:301` | Security / trade authority | Trade creation/acceptance is client-side; items are not server-validated for ownership, league, deadline, roster state, or veto window. | Move trade lifecycle to backend/RPC transactions with accept-time ownership validation and atomic updates. | L |
| P1-25 | `backend/src/routes/draft.ts:26`, `backend/src/routes/draft.ts:73`, `backend/src/routes/draft.ts:104`, `backend/src/routes/playoffs.ts:6` | Security / backend authz | Authenticated users can start drafts, start rookie drafts, reseed rookie picks, and generate/advance playoffs without commissioner authorization. | Require commissioner/co-commissioner and league membership for these endpoints. | M |
| P1-26 | `backend/src/sync/draft.ts:154`, `backend/src/sync/draft.ts:228` | Security / auction transactionality | Bid placement and nomination close are multi-step non-transactional flows; concurrent bids/closes can diverge state or double-apply effects. | Use DB transaction/RPC with row locks or conditional updates; make close idempotent. | L |
| P1-27 | `components/Button.tsx:55`, `app/(tabs)/players.tsx:107`, `components/DaySelector.tsx:22` | Accessibility | Pressables lack roles, labels, state, and hitSlop across app/components; screen readers cannot reliably announce controls. | Add semantics to shared controls and high-volume Pressables; use helper/wrapper for button/toggle semantics. | M |
| P1-28 | `app/(tabs)/players.tsx:938`, `components/DaySelector.tsx:55`, `app/(modals)/draft-room.tsx:562`, `app/(modals)/commissioner-settings.tsx:625`, `components/MatchupRow.tsx:220` | Accessibility / touch targets | Several interactive targets are below 44pt with no hitSlop. | Make targets 44x44 or add hitSlop and explicit labels. | M |
| P1-29 | `app/(modals)/draft-room.tsx:200`, `app/(modals)/draft-room.tsx:211`, `app/(modals)/draft-room.tsx:261` | Mobile polish / auction UX | Auction draft inputs are in a plain `ScrollView` without keyboard avoidance or `keyboardShouldPersistTaps`; keyboard can cover bid controls or swallow bid taps. | Wrap with `KeyboardAvoidingView`, set `keyboardShouldPersistTaps="handled"`, and add bottom inset padding. | M |
| P1-30 | `.github/workflows/test.yml:21` | Build / CI | CI runs tests only. It does not run lint, typecheck, frontend export/build, backend build, workspace tests, or audit gates. Local lint/typecheck currently fail. | Add root scripts and CI jobs for lint, runtime-specific typechecks, workspace tests, backend build, and audits. | M |
| P1-31 | `tsconfig.json:9` | Build / TypeScript hygiene | Root Expo TS config includes all `**/*.ts`/`**/*.tsx`, mixing app, backend, tests, and Deno Edge files under one environment. | Split TS configs by runtime and orchestrate root `typecheck` explicitly. | M |
| P1-32 | `backend/package.json:22`, `backend/package-lock.json:1750` | Dependency security | Backend audit reports high-severity `fast-uri@3.1.0` path traversal/host confusion advisories. | Update Fastify/AJV dependency chain or apply npm override to patched `fast-uri`; rerun audit. | S-M |

## P2 Findings

| ID | Location | Category | Finding | Suggested Fix | Effort |
|---|---|---|---|---|---|
| P2-1 | `backend/src/lib/utils/nameMatch.ts:7`, `supabase/functions/_shared/nameMatch.ts:3` | DRY | Node and Deno name normalization differ. Player matching can drift by runtime. | Move name normalization into `core` with thin runtime re-exports. | M |
| P2-2 | `core/src/dates/index.ts:1`, `lib/shared/week.ts:26`, `lib/games.ts:70`, `backend/src/sync/stats.ts:85` | DRY / dates | Frontend uses local date helpers while NBA jobs use ET dates. Pacific evening can disagree with backend jobs. | Rename helpers to local-vs-ET intent and use ET for NBA-facing code. | M |
| P2-3 | `backend/src/config.ts:12`, `supabase/functions/_shared/syncScores.ts:16`, `supabase/functions/sync-projections/index.ts:5`, `supabase/functions/_shared/batch.ts:3` | DRY / constants | Playoff week, lookback, and batch chunk constants are duplicated between backend and Edge. | Move pure defaults into `core` or Edge-safe shared config. | M |
| P2-4 | `core/src/scoring/formula.ts:10`, `core/src/scoring/types.ts:3`, `app/(modals)/commissioner-settings.tsx:23`, `lib/lineup/autoSet.ts:91` | Architecture / open-closed | Scoring categories are hard-coded in multiple places; adding a stat requires several edits and UI/test coverage already drifts. | Define one `SCORING_CATEGORIES` registry in core with setting key, label, and extractor. | M |
| P2-5 | `app/(modals)/commissioner-settings.tsx:20`, `app/(modals)/commissioner-settings.tsx:169` | Architecture / API boundary | Commissioner screen calls backend admin routes with raw `fetch`, bypassing shared auth/error handling. | Move calls into typed client functions using `apiPost`. | S |
| P2-6 | `hooks/use-lineup-actions.ts:13` | Architecture | `useLineupActions` mixes selection state, movement rules, IR/taxi overflow, persistence, alerts, and autoset orchestration. | Extract pure move validation/planning helpers; leave hook for coordination. | M |
| P2-7 | `app/(tabs)/players.tsx:122`, `components/Avatar.tsx:27` | Frontend performance | Remote headshots use React Native `Image` instead of installed `expo-image`, missing cache/recycling hints. | Switch to `expo-image` with fixed dimensions, `cachePolicy`, and recycling keys. | M |
| P2-8 | `app/(tabs)/players.tsx:743`, `app/(tabs)/players.tsx:73` | Frontend performance | High-volume FlashList rows use inline closures and broad mutable props; visible rows rerender on unrelated state. | Memoize row component/handlers and pass narrow primitive props/intentional `extraData`. | M |
| P2-9 | `app/(tabs)/league.tsx:38` | Frontend performance | League screen fetches standings, waiver order, transactions, and picks together even when only one tab is visible. | Lazy-load/cache per section; prefetch after first paint. | M |
| P2-10 | `app/(modals)/rookie-draft-room.tsx:104` | Frontend performance | Rookie prospects load twice on mount. | Remove duplicate path or guard debounce first render. | S |
| P2-11 | `app/(modals)/draft-room.tsx:84` | Frontend performance | Draft room subscribes to realtime and polls every 5s unconditionally. | Use polling as fallback/backoff while realtime is healthy. | M |
| P2-12 | `backend/src/sync/stats.ts:125` | Backend performance | Box scores are fetched one game at a time in live stats path. | Use bounded concurrency. | M |
| P2-13 | `backend/src/sync/livePoller.ts:140` | Backend performance | Game statuses are updated every tick even when unchanged. | Compare current rows and update/upsert only changed values. | S-M |
| P2-14 | `supabase/functions/live-poll/index.ts:8`, `supabase/functions/_shared/syncScores.ts:5`, `supabase/functions/_shared/syncStats.ts:5` | Backend/Edge architecture | Edge functions duplicate backend live sync implementations and have diverged. | Consolidate live sync into one runtime or shared package with leases. | L |
| P2-15 | `supabase/functions/live-poll/index.ts:44` | Edge performance | Edge `live-poll` does per-game lookup/update every minute. | Fetch all today games once, compare in memory, batch updates. | M |
| P2-16 | `lib/shared/api.ts:23`, `lib/shared/api.ts:34` | Type safety | API client trusts `res.json()` and casts to generic `T`. | Parse as `unknown`, validate response envelope/payloads. | M |
| P2-17 | `supabase/functions/_shared/nba.ts:21`, `supabase/functions/sync-players/index.ts:22`, `supabase/functions/backfill/index.ts:205`, `backend/src/lib/notifications.ts:60` | Type safety / external data | NBA/Sleeper/Expo responses are parsed as `any` or raw unknown then deeply dereferenced. | Add DTOs and boundary validators. | M |
| P2-18 | `app/(tabs)/_layout.web.tsx:103` | Type safety | Web-only style uses `@ts-ignore` and adjacent `as any` casts. | Isolate web style with explicit local type. | S |
| P2-19 | `app/_layout.tsx:16` | Error handling | No Expo Router error boundary found for root/tabs/auth/modal route trees. | Add `ErrorBoundary` exports with retry/navigation actions and safe reporting. | M |
| P2-20 | `lib/shared/api.ts:25` | Error handling | Client throws server-provided `json.error`; UI often renders `e.message`, amplifying raw backend leaks. | Normalize client errors into safe user messages plus diagnostic codes. | M |
| P2-21 | `backend/src/app.ts:16` | Observability | Cron/sync/background code bypasses structured Fastify logging with `console.*`. | Pass logger into jobs or add structured job logger with IDs/context. | M |
| P2-22 | `backend/src/sync/matchups.ts:49`, `backend/src/sync/matchups.ts:59` | Data integrity / idempotency | Matchup generation uses count-then-insert race; force deletes finalized history. | Use deterministic upserts and block force after finalized matchups unless transactional rebuild is explicit. | M |
| P2-23 | `backend/src/sync/draft.ts:37`, `backend/src/sync/rookieDraft.ts:79` | Data integrity / idempotency | Drafts are inserted before child rows; child failure leaves blocking partial draft. | Create draft plus child rows in transaction/RPC with retry-safe upserts. | M |
| P2-24 | `backend/src/sync/seasonReset.ts:97`, `backend/src/sync/seasonReset.ts:113`, `supabase/migrations/20260226000001_initial_schema.sql:550` | Dynasty rules | Waiver priority reset rule conflicts with schema comment; tie order is nondeterministic. | Decide carry-forward vs reseed; add deterministic tiebreakers and docs. | S-M |
| P2-25 | `supabase/migrations/20260226000001_initial_schema.sql:228`, `supabase/migrations/20260226000001_initial_schema.sql:358`, `supabase/migrations/20260226000001_initial_schema.sql:531` | Data integrity / FK structure | Rows store league/season/member IDs independently; composite FKs do not ensure they belong to same league. | Add composite unique keys/FKs for `(league_id, id)` references. | L |
| P2-26 | `backend/src/plugins/auth.ts:16`, `backend/src/plugins/auth.ts:30` | Security / JWT | JWT verification checks signature and `sub` but not issuer, audience, role, project ref, or user existence. | Validate expected claims or use Supabase session validation. | S |
| P2-27 | `backend/src/schemas/index.ts:1` | Security / validation | Schemas allow extra properties, unbounded strings, missing UUID/date formats and numeric bounds. | Add `additionalProperties: false`, formats, lengths, min/max bounds. | M |
| P2-28 | `backend/src/app.ts:18`, `backend/src/routes/notifications.ts:8` | Security / abuse controls | CORS allows all origins, rate limit has `skipOnError`, notifications lack tight route limits/payload limits. | Restrict CORS web origins, review `skipOnError`, add tighter route/user limits. | S |
| P2-29 | `constants/tokens.ts:117`, `components/Button.tsx:23`, `app/(auth)/sign-in.tsx:196` | Accessibility / contrast | White text on primary maple is 3.90:1; success green with white is 2.54:1. | Use darker button/action tokens for text-bearing surfaces. | S-M |
| P2-30 | `constants/tokens.ts:99`, `constants/tokens.ts:100`, `app/(modals)/commissioner-settings.tsx:593`, `app/(modals)/propose-trade.tsx:424` | Accessibility / contrast | Placeholder/muted tokens are used for visible labels below WCAG AA contrast. | Use darker secondary text tokens for visible labels/data. | S |
| P2-31 | `app/(modals)/propose-trade.tsx:249`, `app/(modals)/propose-trade.tsx:370`, `app/(modals)/propose-trade.tsx:390` | Mobile polish | Propose Trade bottom input lacks keyboard avoidance and bottom safe-area handling. | Add keyboard avoidance and bottom inset padding. | S-M |
| P2-32 | `app/(modals)/commissioner-settings.tsx:344`, `app/(modals)/commissioner-settings.tsx:361`, `app/(modals)/commissioner-settings.tsx:440` | Mobile polish | Commissioner Settings numeric inputs/save button can be obscured by keyboard. | Add keyboard avoidance and safe-area-aware bottom padding. | M |
| P2-33 | `package.json:21` | Expo hygiene | `expo install --check` reports Expo-compatible patch mismatches. | Align Expo package versions and add explicit doctor/check script. | S |
| P2-34 | `package-lock.json:5148` | Dependency security | Root audit reports high `@xmldom/xmldom` via Expo tooling and moderate Expo/PostCSS findings. | Update Expo/config plugin chain or cautiously test overrides. | S-M |
| P2-35 | `package.json:57` | Workspace hygiene | Root workspaces coexist with nested package locks/node_modules and extraneous workspace packages. | Choose a single install model and normalize lockfiles/CI. | M |
| P2-36 | `core/package.json:5` | Build hygiene | `core` exposes TS source as main/types but has no build script or CI job. | Add build/typecheck scripts and consume built output, or document source-only model. | S-M |
| P2-37 | `backend/package.json:10` | Build hygiene | Backend build exists but CI does not run it; start uses `tsx src/index.ts` instead of built output. | Decide production runtime: checked `dist` build or TSX runtime with typecheck script. | S |

## P3 Findings

| ID | Location | Category | Finding | Suggested Fix | Effort |
|---|---|---|---|---|---|
| P3-1 | `backend/dist/app.js:2` | Dead code / generated residue | Ignored `backend/dist` exists locally and can be traversed by broad lint commands. | Delete local build output or add explicit lint ignores. | S |
| P3-2 | `lib/lineup/autoSet.ts:3`, `lib/scoring.ts:160`, `components/roster/RosterItems.tsx:114` | Dead code | Unused import, dead variable, and unused headshot error state remain. | Remove or wire the dead code. | S |
| P3-3 | `app/(modals)/claim-player.tsx:15`, `app/player/[id].tsx:14`, `app/(tabs)/players.tsx:27` | Dead code | Unused `isIREligible` imports remain. | Remove imports. | S |
| P3-4 | `lib/shared/api.ts:30`, `lib/waivers.ts:28`, `lib/rookieDraft.ts:150`, `lib/roster.ts:152` | Dead exports | Several exports are not imported in repo. | Remove if not public API or document intended use. | S |
| P3-5 | `constants/theme.ts:30`, `constants/tokens.ts:199` | Dead exports | `Fonts` and `avatarSize` appear unused. | Delete or route consumers through them. | S |
| P3-6 | `backend/src/lib/supabase.ts:11`, `supabase/functions/_shared/syncStats.ts:23`, `backend/src/sync/stats.ts:109` | DRY | Paginated player fetch and lookup-map construction are repeated. | Add client-injected fetch/lookup helper. | M |
| P3-7 | `app/(tabs)/players.tsx:191` | Architecture | `PlayersScreen` is 1,047 lines and owns search/filter/acquisition/drop/render workflows. | Split into hooks and presentational components. | M |
| P3-8 | `components/MatchupRow.tsx:46` | Architecture | `MatchupRow` has 14 props and mixes stats derivation, selection, navigation, and rendering. | Pass a compact view model or split derivation from presentation. | M |
| P3-9 | `app/(modals)/rookie-draft-room.tsx:1`, `app/(modals)/draft-room.tsx:1`, `app/(modals)/commissioner-settings.tsx:1`, `app/(modals)/lineup.tsx:1`, `app/(modals)/propose-trade.tsx:1`, `app/(tabs)/roster.tsx:1` | Architecture | Multiple files exceed 400 lines; several top-level screen functions exceed 80 lines. | Split by workflow boundary after P0/P1 fixes. | M-L |
| P3-10 | `tsconfig.json:3`, `core/tsconfig.json:5`, `backend/tsconfig.json:7` | Type safety | Stronger strictness candidates are absent (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, etc.). | Add incrementally after generated types and current errors are fixed. | M |
| P3-11 | many files | Type safety | 83 `catch (e: any)` and 688 explicit `any`/casts/generics exist across app/backend/edge/tests. | Add `getErrorMessage(e: unknown)` and reduce production `any` after schema typing is fixed. | M-L |
| P3-12 | `app/(tabs)/roster.tsx:77` | Frontend performance | `sortRoster` is recreated each render and invalidates section memos. | Wrap in `useCallback` or inline comparator in memo. | S |
| P3-13 | `components/player/GameLogTable.tsx:57` | Frontend performance | Game log maps all loaded rows inside a `ScrollView`; mounted row count grows with "Load More". | Cap retained rows or virtualize vertical list. | S-M |
| P3-14 | `package.json:39` | Bundle hygiene | Reanimated/worklets appear installed but no animation code was found. | Verify Expo dependency requirements before pruning. | S |
| P3-15 | `backend/src/sync/stats.ts:177` | Backend performance | New `players.nba_id` values are updated one at a time in live stats path. | Batch or bounded-concurrency updates. | S |
| P3-16 | `SCHEMA.md:240`, `SCHEMA.md:282`, `SCHEMA.md:759` | Schema docs | `SCHEMA.md` omits later hot-path columns/indexes such as scores/status/game_time/game_date. | Refresh docs from migrations after index changes. | S |
| P3-17 | `hooks/use-async-data.ts:25` | Observability | Frontend has raw `console.*` calls without production reporting context. | Centralize frontend logging/reporting. | S-M |
| P3-18 | `backend/src/sync/scores.ts:89` | Business rules | Tied matchups are always awarded to home team via `>=`, while standings support ties/tiebreakers. | Implement/document intended tie behavior. | S |
| P3-19 | `backend/src/plugins/errorHandler.ts:20`, `SCHEMA.md:1` | Security docs | Raw error disclosure overlaps P1/P2; `SCHEMA.md` lacks RLS/policy summary. | Add RLS docs after policy fixes. | S |
| P3-20 | `eslint.config.js:8`, `package.json:54` | CI hygiene | Lint has 45 warnings; Vitest emits Vite CJS deprecation warnings. | Burn down warnings and consider `--max-warnings 0`; upgrade Vitest/Vite later. | M |

## Verification Performed During Audit

- `npm run lint` failed: 3 errors, 45 warnings.
- `npx tsc --noEmit` failed under root config, including app errors, backend timer errors, core re-export regressions, and Deno Edge files compiled under the wrong runtime.
- `npm run build --workspace backend` completed successfully in the local environment.
- `npm audit --audit-level=critical --json` reported 0 critical vulnerabilities, but high vulnerabilities remain in backend/root dependency trees.
- Explorer agents ran read-only category audits for A.1-A.11. No code files were edited during Phase A before this report was created.

## Post-Refactor Delta

Initial Phase B pass completed on 2026-05-12. The multi-season harness has not started because P0/P1 is not fully closed.

Resolved or materially reduced:

- P0-1: Removed the literal service-role JWT from the current migration tree and replaced the cron function credential source with `current_setting('app.service_role_key', true)`. External secret rotation and Git history rewrite are still required before production.
- P0-2: Added `supabase/migrations/20260512000001_harden_roster_trades.sql` to replace broad roster RLS with owned-row policies and column-limited IR/taxi updates.
- P0-3/P1-24 partial: Added backend `/trades/:tradeId/accept` and `accept_trade_atomic(...)` RPC to lock, validate, and atomically accept player/pick trades. Remaining trade lifecycle operations still need server-authoritative transactions.
- P0-4: Changed Fastify auth installation from plugin registration to root hook installation, then smoke-tested `/sync/players` and `/e2e/status` returning 401 without credentials.
- P1-2/P1-3: Fixed `@pancake/core` re-export regressions in `lib/roster.ts` and `lib/shared/week.ts`.
- P1-4 partial: Updated Edge shared scoring/sync-score logic to use date-range season weeks and include FG/FT scoring fields, reducing backend/Edge drift.
- P1-12: Added live poller in-flight/finalization guards and per-date delayed final-sync dedupe.
- P1-15: Added `idx_pgs_game_date_player` migration and documented it in `SCHEMA.md`.
- P1-16/P1-18: Backend 500s now return a generic message with `requestId`; fatal unhandled process errors now exit after logging.
- P1-17: Added Edge shared `internalServerError(...)` response helper and replaced top-level raw 500 responses in sync, live-poll, backfill, waiver, and verify functions.
- P1-5: Removed Supabase Edge imports that reached outside `supabase/functions` into `core/src`; Edge now has documented local copies for scoring/season helpers because Supabase deployment cannot consume the local workspace package directly.
- P1-22: Added shared service-role-only `process_next_waiver_claim_atomic(...)` RPC and moved both backend and Edge processors to it, so active roster counts exclude IR/taxi consistently and priority is re-evaluated under league-season row locks after each claim.
- P1-23: Added backend waiver claim submit/cancel endpoints, moved the app client to those endpoints, and added a migration dropping direct client INSERT/UPDATE policies on `waiver_claims`.
- P1-6/P1-7: Started local Supabase successfully, applied all migrations through `20260512000007_atomic_waiver_processing.sql`, regenerated `types/database.ts` from the live local schema, copied generated runtime-local type files for backend and Edge, and parameterized both Supabase service clients with `Database`.
- P1-8: Removed `supabase as any` / `as any` from the explicitly audited app modules `lib/trades.ts`, `lib/waivers.ts`, `lib/rookieDraft.ts`, `lib/players.ts`, and `lib/roster.ts` after type regeneration.
- P1-10: Added a single `AuthProvider` so app screens/hooks consume one Supabase session fetch, auth-state subscription, and AppState refresh listener instead of creating one per `useAuth()` caller.
- P1-9: `useFocusAsyncData` now keeps existing data visible, dedupes in-flight loads, and uses a 30s stale-while-revalidate TTL instead of blocking every focus.
- P1-11: `useLiveStats` now shares per-date snapshots, in-flight requests, subscribers, and a single today polling interval across consumers.
- P1-14: Batched backend and Edge score sync by fetching matchups, starter lineups, and player stats once per league-week, aggregating member totals in memory, and bulk upserting matchup point updates.
- P1-21: Added `snake_draft_picks.draft_pick_id`, populated it during rookie draft start/reseed, and mark the exact linked `draft_picks` asset used when a rookie pick is made.
- P1-20: Moved IR/taxi placement behind backend endpoints that validate owner, injury/rookie eligibility, slot caps, activation roster space, lineup clearing, and transaction logging; direct client update grants for those flags are revoked in a migration.
- P1-13: Added service-role-only `try_live_poll_lock()` / `release_live_poll_lock()` advisory-lock RPCs and wrapped backend live poller ticks plus Edge `live-poll` with the shared lease.
- P1-19: Replaced multi-step season reset implementation with `advance_season_atomic(...)` RPC wrapper.
- P1-25: Added commissioner authorization checks to draft start, rookie draft start, rookie reseed, playoff generate, and playoff advance routes.
- P1-26: Added service-role-only `place_auction_bid_atomic(...)` and `close_auction_nomination_atomic(...)` RPCs, then moved backend bid placement and expired nomination close to those locked database transactions.
- P1-27/P1-28/P1-29 partial: Added accessibility semantics/hitSlop to shared buttons and high-volume draft/player controls; added keyboard avoidance to the auction draft room.
- P1-30/P1-31/P2-36/P2-37: Split root/backend/core typecheck/build scripts and expanded CI to run lint, app typecheck, backend typecheck/build/tests, and core typecheck/test.
- P1-32/P2-34 partial: Added narrow npm overrides for `fast-uri@3.1.2` and `@xmldom/xmldom@0.8.13`; `npm audit --audit-level=high` now reports zero high/critical vulnerabilities.
- P3-20: `npm run lint` now completes with zero warnings.

Still blocking production readiness:

- P0-1 external: rotate Supabase credentials, invalidate any deployed secret-bearing cron/function state, and rewrite/purge Git history.
- Real test Supabase project, Fastify backend, Expo frontend, and browser-driven multi-season soak have not run yet.
- Edge deploy caveat: Edge functions now pass local `deno check`, but they have not been deployed to or smoke-tested against the real test Supabase project.
- P2-34 remaining: Moderate Expo/PostCSS/Vitest/Vite audit findings remain and require broader SDK/test-runner upgrades.

Phase C scaffold added after the initial Phase B hardening commit:

- Added upstream seams for backend and Edge NBA/Sleeper callers: `NBA_CDN_BASE_URL` and `SLEEPER_BASE_URL` now route scoreboards, boxscores, schedules, historical backfill, health checks, and player syncs through configurable bases.
- Added `tests/e2e/fake-upstream.mjs`, a controllable fake NBA CDN/Sleeper server on port `4555` with admin controls for clock, game status, player stat mutation, injuries, and season advancement.
- Added `tests/e2e/soak.mjs` plus `npm run e2e:soak`. The runner starts the fake upstream, requires explicit real test Supabase/backend/frontend env, snapshots dynasty-critical tables, and runs D.0 boundary invariant checks. It fails closed and writes `tests/e2e-report.md` when the environment is not wired.
- Added `tests/e2e/README.md` documenting required E2E environment variables and outputs.
- Added E2E-only backend tick routes under `/e2e/*`, registered only when `ENABLE_E2E_ROUTES=1` and protected by `E2E_ADMIN_SECRET`; the soak runner can call those routes when `E2E_ENABLE_BACKEND_TICKS=1`.

Verification after initial Phase B pass:

- `npm run lint`: pass, zero warnings.
- `npm run typecheck`: pass.
- `npm run typecheck --workspace backend`: pass.
- `npm run typecheck --workspace core`: pass.
- `npm run build --workspace backend`: pass.
- `npm audit --audit-level=high --json`: pass, zero high/critical vulnerabilities; 9 moderate vulnerabilities remain.
- `npx supabase start`: pass; all migrations through `20260512000007_atomic_waiver_processing.sql` applied locally.
- `npx supabase gen types typescript --local > types/database.ts`: pass.
- `deno check supabase/functions/*/index.ts`: pass.

Verification after Phase C scaffold:

- `node tests/e2e/fake-upstream.mjs` plus curl smoke checks for `/admin/state`, scoreboard, boxscore, play-by-play, player index, and Sleeper player endpoints: pass.
- `node --check tests/e2e/soak.mjs && node --check tests/e2e/fake-upstream.mjs`: pass.
- Supabase CLI: `npx supabase migration list --linked` initially showed remote-only `20260427000001` and local-only `20260512000001` through `20260512000007`; `npx supabase migration fetch --linked` added the missing remote migration locally, and `npx supabase db push --linked` applied the seven post-refactor migrations to the linked project.
- Added and pushed `20260512000008_dynamic_league_lifecycle_rpcs.sql`: `create_league` and `join_league_by_invite_code` now seed a rolling five-year, three-round pick bank; the frontend `createLeague()` now uses the authenticated RPC instead of direct client inserts.
- `npm run e2e:seed`: created 10 confirmed E2E users, created an isolated league through `create_league`, joined the other 9 users through `join_league_by_invite_code`, verified 10 `league_members` plus 150 future draft-pick rows for 2027-2031, and wrote ignored `tests/e2e-state.json` for scoped soak runs.
- `npm run e2e:soak`: after loading `.env` and `backend/.env`, schema preflight passed for post-refactor RPCs/columns, then completed 10 seasons of D.0 boundary invariant reads/snapshots against the latest seeded league and wrote a `PARTIAL` `tests/e2e-report.md`; it still exits nonzero because browser-driven scenarios have not run.
- E2E backend route smoke: with `ENABLE_E2E_ROUTES=1`, `E2E_ADMIN_SECRET`, `DISABLE_CRON=1`, and fake NBA/Sleeper bases, `/e2e/status` returned 200 with the secret, while `/e2e/status` and `/sync/players` returned 401 without credentials.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak -- --seasons=1`: pass in `PARTIAL` mode. The runner exercised `/e2e/status`, `/e2e/sync-schedule`, `/e2e/sync-players`, `/e2e/live-poll`, `/e2e/process-waivers`, and `/e2e/generate-matchups` against a real local Fastify server plus fake NBA/Sleeper upstream, then completed scoped D.0 invariant checks.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak`: pass in `PARTIAL` mode for 10 seasons. The runner now calls the real `/e2e/advance-season` endpoint each loop and re-checks invariants after reset, including the rolling five-year pick-bank horizon.
- `E2E_ENABLE_BROWSER=1 E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 E2E_FRONTEND_URL=http://127.0.0.1:8081 npm run e2e:soak`: pass in `PARTIAL` mode for 10 seasons. Each season ran backend ticks, real season reset, D.0 invariant checks, agent-browser sign-in, and Home/Players/Roster/Trades/League screenshot smoke. This is not a passing dynasty soak because the full D.SET/D.SEA/D.X/D.LONG scenario assertions are still pending.
- Direct Supabase post-run check for the latest seeded league: current season is 2049 with exactly one current `league_seasons` row, 24 season rows, 840 draft-pick rows, and draft-pick years spanning 2027-2054.
- `E2E_ENABLE_PICK_CHAIN=1 E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak`: pass in `PARTIAL` mode for 10 seasons. The runner created a three-hop future-pick trade chain for a five-years-out round-one pick through `accept_trade_atomic`, checked the exact `draft_picks.current_owner_id` at every season boundary, and wrote scenario metadata to `tests/artifacts/future-pick-chain.json`.
- D.LONG.1 rookie-draft pick-chain check added: when the multi-hop traded target pick reaches its draft year during a backend-tick run, the runner starts the real rookie draft and verifies the linked `snake_draft_picks.draft_pick_id` slot belongs to the final traded owner. The slot artifact is written to `tests/artifacts/season-<N>/rookie-draft-pick-chain.json`.
- Soak failure logged, approval required before fixing: `E2E_ENABLE_PICK_CHAIN=1 E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak -- --seasons=10` stopped when the new D.LONG.1 check reached target pick `ac1cf993-45ec-4b42-b573-04438b72a583` for season_year 2059. The real rookie draft `df04435e-e375-4a60-8482-b354a7cf64fd` did not materialize that pick; inspection showed the draft slots were linked to stale 2027 unused pick assets instead. Likely root cause: the current soak loop skips annual rookie drafts for intervening seasons, so `startRookieDraft()` consumes the earliest unused pick bank rather than the current target year. Do not silently patch; choose whether to fix the harness by running/marking annual rookie drafts each offseason, or harden rookie-draft seeding to select the current season_year explicitly.
- Direct Supabase post-run check for the pick-chain league: current season is 2036 with exactly one current `league_seasons` row, 11 season rows, 450 draft-pick rows spanning 2027-2041, and the season-2031 target pick still owned by the expected final multi-hop owner.
- `E2E_BROWSER_AUTH_USERS=10 npm run e2e:browser-auth`: pass. The agent-browser scenario ran 10 isolated browser sessions in parallel against Expo web, verified protected-route auth guard, signed in each seeded user, verified profile/session persistence, signed out through the real profile UI, verified the auth guard returned, and wrote screenshots/errors under `tests/artifacts/season-0/auth/user-*/`.
- `E2E_ENABLE_BROWSER_AUTH=1 E2E_BROWSER_AUTH_USERS=2 npm run e2e:soak -- --seasons=1`: pass in `PARTIAL` mode. The soak runner invoked the browser auth scenario inside the season loop and still exited nonzero because full gameplay browser scenarios remain pending.
- D.SEA.7 snapshot-diff check added: `tests/snapshots/season-*/summary.json` records dynasty-critical row counts; the runner now fails if any snapshot table shrinks across seasons, and backend-tick runs require `draft_picks`, `league_seasons`, and `waiver_priorities` to grow after real season resets.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak -- --seasons=2`: pass in `PARTIAL` mode. Snapshot summaries grew from 540 to 570 `draft_picks`, 14 to 15 `league_seasons`, and 130 to 140 `waiver_priorities` across the second real reset.
- D.SEA.1 matchup idempotency check added: when backend ticks are enabled, the runner counts target-league current-season `matchups`, calls `/e2e/generate-matchups` a second time with `force: false`, and fails if the count changes or if no schedule exists for a league with enough members.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak -- --seasons=2`: pass in `PARTIAL` mode after the D.SEA.1 check was added. Both seasons reported `matchup generation idempotency passed`; snapshot summaries grew from 600 to 630 `draft_picks`, 16 to 17 `league_seasons`, and 150 to 160 `waiver_priorities`.
- D.X.3 CORS preflight check added: backend-tick mode sends an `OPTIONS` preflight to `/e2e/status` with the configured frontend origin and verifies allow-origin, allow-methods, and allow-headers before the season loop.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 npm run e2e:soak -- --seasons=1`: pass in `PARTIAL` mode after the D.X.3 check was added. The report includes `CORS preflight check passed for the configured frontend origin.`
- D.LONG.6 runtime drift check added: the runner writes `tests/artifacts/perf-metrics.json` every season; runs of 10+ seasons now fail if latest season runtime exceeds season 1 by more than `E2E_PERF_DRIFT_LIMIT` (default `1.2`, matching the requested 20% ceiling).
- `npm run e2e:soak -- --seasons=10`: pass in `PARTIAL` mode after the D.LONG.6 check was added. The runtime drift gate executed on season 10 and passed; recorded season 1 runtime 767ms and season 10 runtime 664ms in `tests/artifacts/perf-metrics.json`.
- D.LONG.7 harness memory drift check added: `tests/artifacts/perf-metrics.json` now includes per-season `process.memoryUsage()` snapshots. Runs of 10+ seasons fail if RSS or heap memory exceeds season 1 by more than `E2E_MEMORY_DRIFT_LIMIT` (default `1.2`).
- `npm run e2e:soak -- --seasons=10`: failed after the D.LONG.7 gate was added. In invariant-only mode, season 10 RSS grew from 105.6 MiB to 129.8 MiB (+23%) and heap grew from 10.2 MiB to 17.9 MiB (+75%), exceeding the 20% default limit. This may be real harness retention from repeated full-table snapshots or V8 GC noise; do not silently loosen the gate. Approval needed before fixing by reducing snapshot memory retention, adding explicit GC-aware measurement, or revising the threshold with evidence.
- Prompt-to-artifact coverage checklist added: every soak run now writes `tests/e2e-coverage.md`, mapping the explicit D.SET/D.SEA/D.X/D.LONG requirements and exit criteria to PASS/PARTIAL/PENDING/FAIL evidence so a `PARTIAL` report cannot be mistaken for dynasty-stable.
- D.X.1 trade push intercept added: backend and Edge notification senders now honor `EXPO_PUSH_URL`; the fake upstream captures Expo push requests at `/--/api/v2/push/send`; `E2E_ENABLE_PUSH=1` signs in as a seeded user, calls the real authenticated `/notify/trade` route, and asserts the fake captured the payload in `tests/artifacts/season-<N>/push-notifications.json`. This is intentionally marked partial because waiver/draft push assertions are still pending.
- `E2E_ENABLE_BACKEND_TICKS=1 E2E_API_BASE_URL=http://127.0.0.1:3101 E2E_ADMIN_SECRET=... E2E_ENABLE_PUSH=1 npm run e2e:soak -- --seasons=10`: pass in `PARTIAL` mode after the D.X.1 trade push intercept was added. All 10 seasons reported `trade push notification intercept passed`; season 10 artifact captured `E2E Trade Proposed S10`; runtime drift still passed (season 1 8350ms, season 10 8505ms).
- D.X.1 waiver push intercept added, failure logged and approval required before fixing: `E2E_ENABLE_PUSH=1` now also seeds a pending waiver claim, runs the real backend `/e2e/process-waivers` path, and asserts the fake Expo server captured the `Waiver Claim Succeeded` push. Verification stopped on the first season because `/e2e/process-waivers` returned 500 from `process_next_waiver_claim_atomic(...)`: Postgres error `42702`, `column reference "player_id" is ambiguous`. This is a real waiver-processing path failure surfaced by the soak harness. Do not silently patch; user approval is needed before changing the waiver RPC. Draft notification assertions remain pending.
- Local Fastify smoke: backend starts with `DISABLE_CRON=1`, fake NBA/Sleeper upstream bases, and Supabase Auth token-validation fallback when `SUPABASE_JWT_SECRET` is absent.
- Local backend blocker found: the configured Supabase project is missing `try_live_poll_lock()`, so the post-refactor migrations are not fully applied there. Starting without `DISABLE_CRON=1` runs sync jobs and already wrote player-status updates from the fake Sleeper feed.
- Agent-browser smoke: Expo web loaded at `http://localhost:8081`, signed in with the configured test user, and opened Home/Players/Roster/Trades/League with no uncaught browser errors. Console warnings remain for the `lib/transactions.ts -> lib/players.ts -> lib/transactions.ts` require cycle and Expo notifications web support.
- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm run typecheck --workspace backend`: pass.
- `npm run typecheck --workspace core`: pass.
- `npm run build --workspace backend`: pass.
- `deno check supabase/functions/*/index.ts`: pass.

## Phase B Initial Work Queue

1. Security emergency: rotate/remove committed service-role JWT and fix roster RLS.
2. Transactional dynasty flows: trade lifecycle, waiver lifecycle, auction bid/close, season reset, rookie draft pick asset linkage.
3. Build reproducibility: commit/package `core`, split runtime TS configs, restore lint/typecheck gates.
4. Runtime drift: unify backend/Edge scoring and waiver processing.
5. Authz/error hardening: commissioner-only endpoints, safe 500 responses, fatal process exit.
6. Frontend P1s: shared auth/live-stat/focus caches and auction accessibility/keyboard fixes.
