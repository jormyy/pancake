# WORKLOG — task t_a4dc0293 (hardening iteration)

Branch: `task/t_a4dc0293-hardening`. Baseline commit: `2909a0a` (main, clean tree) on 2026-09-12.
Host: MAIN MacBook, Node v26.7.0, Deno, psql 14 client, Supabase CLI. All commands ran inside the
Claude Code sandbox (no local port binding; no Docker socket). Correction 2026-09-12: the earlier
claim that filesystem writes were bounded to repo + tmp was wrong; the launch inspector showed the
sandbox did not bound file writes. No writes outside the repo, the scratchpad and `$TMPDIR` were made
by this session, but that was by practice, not enforcement.

Evidence directory: `docs/evidence/2026-09-12-hardening-t_a4dc0293/`.

## 1. Baseline (before any edit)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck app | `npm run typecheck` | PASS (3.1 s wall) |
| Typecheck tests/e2e/harness/core | `npm run typecheck:tests`, `:e2e`, `:harness-boundaries`, `:core` | PASS |
| Unit tests | `npx vitest run` | PASS 115 files / 664 tests, 2.1 s wall |
| Core workspace tests | `npm test --workspace core` | PASS 13 files / 112 tests |
| Lint | `npm run lint:all` | PASS |
| Dead code | `npm run check:dead-code` (knip) | PASS |
| Generated-copy parity | `check:edge-shared`, `check:db-function-sources`, `check:core-cjs` | PASS |
| Edge inventory / surface matrix | `check:edge-function-inventory`, `check:surface-matrix` | PASS (23 surfaces, 21 functions) |
| Perf budget contract | `npm run perf:budget` | PASS (contract only; no fresh browser report) |
| Web release export | `npx expo export --platform web --clear` | PASS, 12.6 s wall, 117 files, dist 8.0 MB |
| Deno edge tests | `deno test --allow-all --no-check supabase/functions` | 44 passed / 9 failed: 8 fail on `Deno.serve` listen = sandbox EPERM (environment); 1 (`syncStats.test.ts`) fails at import: module eagerly builds a Supabase client and throws `Missing Supabase secret key` with no env |
| DB function catalog | `npm run check:db-function-catalog` | BLOCKED: needs `SUPABASE_DB_URL` (local stack) |
| DB behaviour tests (`npm run test:db`), e2e harnesses, browser scenarios | — | BLOCKED, see §2 |

Bundle (release export, gzip -9): `__common` 413,629 B, `entry` 264,314 B, `league` 38,196 B,
`index.html` 18,579 B, `sw.js` 2,238 B, all JS 877,584 B. See `bundle-sizes.txt`.

Read-only production latency probe (curl, 5 samples, from this host; no writes, no sign-in):
`GET /health` 0.18–0.37 s; PostgREST `players?select=id&limit=1` 0.18–0.33 s. See `api-latency-probe.txt`.
These are single-host WAN samples, not a load test.

Initial JS (`__common` + `entry`, gzip -9) = 677,943 B ≈ 662 KiB against the manifest budget
`maxInitialWebJsKb` 700 (the browser gate measures encoded transfer size, which on the host CDN is
brotli, so this local gzip figure is an upper bound).

## 2. Environment limits (verified, evidence in `local-stack-failure.txt`)

- Docker Desktop socket exists (`~/.docker/run/docker.sock`) but the sandbox denies connecting:
  `permission denied while trying to connect to the docker API`. `supabase start` / `supabase status`
  fail with `LegacyDockerLifecycleInspectError` for the same reason. `open -a Docker` is refused
  (`procNotFound`). The Supabase CLI also cannot write `~/.supabase/telemetry.json` (EPERM).
- Node and Deno cannot bind a local port (`EPERM` on `listen`), so the static web server, fake
  upstream, browser scenarios and the Deno tests that spin up local servers cannot run here.
- Homebrew Postgres 14 exists but the 304 migrations depend on Supabase-only schemas
  (`cron`, `net`, `vault`, `auth`), so it cannot host the migration set.
- `.env` points at the production Supabase project. Per task rules no production writes; only
  read-only probes were made.

Consequence: every DB behaviour test and e2e harness remains UNRUN in this iteration. Static and
unit checks are recorded as what they are and do not stand in for that coverage. Running
`npm run test:db` and the perpetual/browser harnesses on an unsandboxed host with Docker is the
first item for the review handoff.

## 3. Iterations

(appended below as work proceeds)

### Iteration 1 — 2026-09-12 (review fan-out + first fixes)

Four read-only functional reviews (roster/pickup/drop rules; scheduled ops and season
transitions; PWA + mobile states; DB performance + dead code) produced ~45 candidate findings.
Each fix below was verified in source by me before changing anything. Findings that need a
database to change safely are listed under "Deferred to review" and were NOT implemented.

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `41a261a` | `_shared/statDiff.ts`: pure stat-diff helpers split out of `syncStats.ts` so `deno test` no longer needs a Supabase secret at import | `deno test --allow-all supabase/functions/_shared/statDiff.test.ts` → 6 passed (was: uncaught import error) |
| `2c44a07` | `public/sw.js`: refuse HTML/non-basic responses for asset caches (host rewrites unknown paths to `+not-found.html` HTTP 200, which poisoned the immutable cache after a deploy); reject instead of resolving `respondWith(undefined)` when offline with a cold cache | `npx vitest run tests/service-worker.test.ts` → 9/9; the 3 new cases fail on the previous worker |
| `2ec4589` | `shared-src/sync/scores.ts` (+ generated `_shared/syncScores.ts`): only send playoff rows whose decision changed back to `finalize_score_week_atomic`. The RPC re-stamps `finalized_at` on every playoff row it receives; the closed round stayed in the 2-week sync window so every live-poll tick reset the 48h boundary grace and the bracket never advanced | `deno test --allow-all supabase/functions/_shared/finalizationWrite.test.ts` → 5 passed; `check:edge-shared` PASS. Not run against a DB here |
| `aea0e49` | `_shared/retry.ts`: per-attempt AbortSignal/timeout; caller abort not retried; NBA CDN + draft-order callers pass `attemptTimeoutMs` | `deno test --allow-all supabase/functions/_shared/retry.test.ts` → 4 passed; 2 cases FAIL on the previous helper |

Deferred to review (need DB to change/test; not implemented):
- SQL-side rule gaps: `edit_waiver_claim_atomic` skips the create-time gates and resets `submitted_at`;
  `drop_player_atomic`/`toggle_ir_atomic` do not check pending claims that name the player as
  `drop_player_id`; free-agent UI treats an uncleared-but-expired waiver row as a free agent while
  the `roster_players` trigger still blocks the add; `activate_roster_player_with_overflow_atomic`
  reaches IR/taxi toggles without the Edge lineup-lock check.
- Scheduled ops: cron→edge invocation is fire-and-forget (no `sync_runs` row if the function never
  boots); minute-exact ET gates skip a day/week on dispatch delay; stats-range jobs park after 3
  failures with no resurrection; live-poll lease TTL (90s) shorter than a busy night's work.
- Index candidates: `sync_runs(started_at)`, `projection_sync_runs(started_at)`,
  `standings(league_season_id, member_id, week_number desc)`,
  `roster_transactions(league_id, player_id, occurred_at desc)`; drop
  `idx_trade_participants_league_member` (strict prefix of a wider index).
- Genuine rule ambiguities (docs/config do not settle): FAAB not reserved across pending claims;
  meaning of `finalized_at` for playoffs (first decision vs last reconciliation); offseason
  synthetic add-week numbering vs `resolveSeasonWeekNumber`; season-year flip on Oct 1.

Paused here at a clean tree on user request (sandbox adjustment pending for DB/browser tests).

### Iteration 2 — 2026-09-12 (LOCAL TEST PHASE, sandbox temporarily lifted for local DB/browser only)

Environment: Docker Desktop reachable; `supabase start` (first attempt hit Docker Hub
`toomanyrequests` mid-pull, second attempt exit 0); local API `http://127.0.0.1:54321`, local DB
`127.0.0.1:54322`. All env for this phase came from `supabase status` written to private 0600 files
in the scratchpad; the writer refuses any non-loopback URL. `.env` (production) was not used for any
write; production restrictions unchanged. Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local/`
(secrets redacted, leak-checked).

The local Docker volume still held e2e leagues from 2026-08-15..27 (18 leagues). `supabase db reset`
rebuilt the DB from scratch: 304 migrations applied cleanly in 27.8 s (`db-reset.txt`).

| Check | Command | Result |
| --- | --- | --- |
| Deno edge tests | `deno test --allow-all --no-check supabase/functions` | PASS 109/0, exit 0 (baseline in sandbox: 44/9) |
| DB behaviour suites | `npm run test:db` (17 suites) | PASS, exit 0 (`test-db.txt`) |
| DB function catalog | `npm run check:db-function-catalog` | PASS, exit 0 |
| Perpetual season (branch, 2 rollovers, boundary on) | `npm run e2e:perpetual` | PASS, exit 0, 20.7 s: 48h grace waited, in-window correction re-decided SF, closed SF immutable, 160-claim drain (`perpetual-season.txt`, `-report.json`) |
| Perpetual red-proof | `npm run e2e:perpetual -- --disable-boundary` | **BLOCKED** (exit 1 for the wrong reason): harness `cleanupPreviousRuns` deletes `players LIKE 'perpetual-%'` before `roster_players`; FK `roster_players_player_id_fkey` fails on any second run against the same DB. Reproduced twice. Pre-existing harness defect, preserved in `perpetual-disable-boundary-red-proof-BLOCKED.txt` |
| finalized_at re-stamp (motivation for `2ec4589`) | psql demo on local DB | unchanged finalized QF row passed back to `finalize_score_week_atomic` → `finalized_at` advanced (`restamped = t`), 0 notifications (`finalized-at-restamp-demo.txt`) |
| PWA deploy-update gate | `node tests/e2e/pwa-update.mjs --previous=<main 2909a0a dist> --next=dist` | PASS, exit 0: both releases precache 14/14 boot assets, only the activated release keeps caches, first relaunch mounts (`pwa-update-report.json`) |
| Seed browser fixture | `npm run e2e:seed` | PASS, exit 0 (10 users, 80 players, no rosters by design) |
| PWA launch | `npm run e2e:browser-pwa-launch` | PASS, exit 0: shell paint 6.7 ms, app mounted 28 ms, FCP 44 ms vs 400 ms budget |
| Browser perf | `npm run e2e:browser-perf` | PASS, exit 0: feedback 5.8–6.7 ms (budget 100), max long task 0 ms, heartbeat lag 4 ms |
| Data latency | `npm run e2e:data-latency` | PASS, exit 0 (report copied) |
| Lineup / waiver / waiver-drop / trade | `npm run e2e:browser-lineup`, `-waiver`, `-waiver-drop`, `-trade` | PASS, exit 0 each |
| Browser smoke, tab-only | `npm run e2e:browser-smoke` | **FAIL exit 1** on branch dist, on rerun, and on BASELINE main dist: `Workflow roster-review-manage did not reach its ready state`. Cause: the roster fixture row is only inserted in full-sweep mode and `roster.tsx` renders the auto-set control only when the roster is non-empty. Pre-existing; preserved in `browser-smoke-tab-only-failure.txt` |
| Browser smoke, full sweep | `E2E_BROWSER_FULL_SWEEP=1 npm run e2e:browser-smoke` | PASS, exit 0, 1:27 wall |
| Perf budget gate | `npm run perf:budget -- --require-report` | FAIL after the tab-only smoke (downstream of that report), PASS after the full-sweep smoke |

Not run: `e2e:soak` / `e2e:soak:release` (long multi-season release gate), `browser-auth`,
`browser-playoff`, `browser-rookie-draft`, `browser-league-lifecycle`, `waiver-ir-block`,
`parity:players`, `prod:*` (production-facing by definition). Left for the next phase or review.

Local servers and the Supabase stack were stopped at the end of this phase; the local volume keeps
the seeded/perpetual data. Paused at a clean tree for sandbox restoration.

### Iteration 3 — 2026-09-12 (implementation, sandbox on)

Sandbox note: with the command sandbox restored, Bash could not write any file under `hooks/`
(`touch hooks/use-online-status.ts` → `Operation not permitted`; `components/`, `lib/`, `app/`,
`tests/` were writable). `hooks/use-focus-async-data.ts` was edited through the harness Edit tool.
`git stash` on that file also failed for the same reason; nothing was lost (verified by diff).

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `f619cf3` | `tests/e2e/harness-cleanup.mjs`: FK-ordered removal of harness players (12 referencing tables, children first) used by `perpetual-season.mjs`; `ensureRosterFixture` (seeded `e2e-player-*` only) runs in tab-only smoke as well as full sweep | `tests/e2e-harness-fixtures.test.ts` 8 cases (fake client + source contracts). Real re-run of `e2e:perpetual --disable-boundary` and tab-only `e2e:browser-smoke` is queued for the next local phase |
| `e9a8ee0` | WORKLOG correction: sandbox did not bound file writes in the baseline phase | — |
| `687e735` | Home: failed matchup load shows a retry state, never "No matchup this week yet"; Trades: empty text for offers/block/league block/history; `+html.tsx`: update check on `online` + hourly while visible, worker-version wait 2 s → 10 s | `tests/ux-state-contracts.test.ts` |
| `0623e2c` | season-boundary records per-league failures on `sync_runs` (`recordSyncRun` gains `failure`); process-waivers notifies per committed batch; `/sync/backfill/:id` projects columns; migration `20260912000001` adds `sync_runs(started_at)`, `projection_sync_runs(started_at)`, `standings(league_season_id, member_id, week_number desc)`, `roster_transactions(league_id, player_id, occurred_at desc)` | `seasonBoundaryFailures.test.ts` 3 cases; source contracts; migration-deployment-safety PASS. Indexes not yet applied to any DB |
| `1a27a2c` | `useFocusAsyncData` refetches on `online` (forced) and on visibility return (stale-gated), listeners removed on unmount; DaySelector compact cells 36 → 44 px tall | `tests/hooks/focus-async-data.test.ts` (fails with listeners removed) |
| `7ff4ab5` | `edit_waiver_claim_atomic` applies the create-time gates (league status, current season, weekly add, open waiver window, no self-drop); migration `20260912000002`; DB test `tests/db/waiver-claim-edit-gates.sql` added to `npm run test:db` | `check:db-function-sources` PASS. DB test NOT executed here |

Static gates after this iteration: `lint:all`, all five typechecks, `check:core-cjs`, `check:dead-code`,
`check:edge-shared`, `check:edge-function-inventory`, `check:db-function-sources`,
`check:surface-matrix` all exit 0; `npx vitest run` 117 files / 684 tests; Deno suite 62 passed,
8 failed only on sandbox `Deno.serve` listen (109/0 when run unsandboxed in iteration 2).

Deliberately not changed (rule ambiguity, docs do not settle):
- `edit_waiver_claim_atomic` still resets `submitted_at`; whether an edit is a resubmission is
  undocumented.
- `prevent_uncleared_waiver_free_agent_add` trigger blocks on `cleared_at IS NULL` while
  `add_free_agent_atomic` and the client use `clears_at > now()`. The sweep keeps a hold while
  claims are pending, so the trigger may be the intended backstop; which predicate wins between an
  expired hold with pending claims and a free-agent add is not written down.
- FAAB reservation across pending claims; offseason synthetic add-week numbering; Oct 1 season
  year flip; playoff `finalized_at` meaning (the code fix keeps both readings consistent by not
  re-stamping unchanged rows).

Remaining test/review gates (not self-approved):
1. Local test phase: `supabase db reset` (applies the two new migrations), `npm run test:db`
   (includes the new waiver-edit-gates test), `npm run e2e:perpetual` and
   `npm run e2e:perpetual -- --disable-boundary` (red-proof must now run), tab-only
   `npm run e2e:browser-smoke`, `npm run e2e:pwa-update` main→branch, `npm run e2e:browser-perf`,
   `npm run perf:budget -- --require-report`, plus the scenarios not run in iteration 2.
2. Index DDL: confirm no duplicate/overlapping index in production catalog before predeploy build.
3. Independent Opus review of every commit on `task/t_a4dc0293-hardening` (main..HEAD).

### Iteration 4 — 2026-09-12 (LOCAL TEST PHASE 2, sandbox temporarily off; evidence only, no code edits)

Stack: `supabase start` exit 0, `supabase db reset` exit 0 (306 migrations incl. `20260912000001/2`,
all four new indexes present), local API/DB on 127.0.0.1 from the private env files; production `.env`
unused. Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase3/` (redacted, leak-checked).
Independent review round 1 retained verbatim at `local-phase3/independent-review-round1.md` (verdict BLOCK;
gating item B1 = the new DB test's fixtures). No fixes were applied in this phase.

| Check | Result |
| --- | --- |
| `deno test --allow-all --no-check supabase/functions` | PASS 112/0, exit 0 |
| `npm run test:db` (18 suites) | exit 3: 17 pass; **`waiver-claim-edit-gates.sql` FAILS at fixture** (`No waiver priority found for your team.`; then `leagues_weekly_add_limit_valid` when limit=0). Confirms review B1 |
| ad-hoc copy of that test with a `waiver_priorities` row and limit=1 + `consume_weekly_add` | all 5 gates refuse correctly, final state intact, ROLLBACK (`waiver-edit-gates-adhoc.txt`) |
| `check:db-function-catalog` | PASS |
| `e2e:perpetual` run1 (fresh DB) | PASS exit 0 |
| `e2e:perpetual` run2/run3, `--disable-boundary` on same DB | exit 1: **residual defect in `f619cf3`**: `PLAYER_REFERENCE_TABLES` lists `trade_drop_reservations`, dropped by `20260709100027`; PostgREST returns "table not in schema cache" before any delete runs |
| `e2e:perpetual -- --disable-boundary` after `db reset` | exit 1 with 4 boundary FAIL rows — red-proof reproduced for the intended reason |
| `pwa-update` main 2909a0a → branch | PASS exit 0 (`pwa-update-report.json`) |
| Browser chain on branch: pwa-launch, **tab-only smoke (now PASS, was FAIL)**, perf, data-latency, lineup, lineup-auto-set, lineup-locked, waiver, waiver-drop, waiver-ir-block, trade, auth, playoff, rookie-draft, league-lifecycle, full-sweep smoke | all exit 0 (`browser-chain-exits.txt`) |
| `perf:budget --require-report` / `--require-workflow-reports` | exit 1 after tab-only smoke (report lacks player-detail), exit 0 after full sweep |
| Baseline vs branch (same host/league/stack, back to back) | within noise: shell paint 8.7→7.8 ms, app mounted 37.2→37.4 ms, FCP 36→44 ms; workflow feedback 3.4/8.4→2/3.7 ms, full load 439/727→430/703 ms; initial JS 567.7→567.5 KB; data-latency medians 10–22 ms both, all PASS (`baseline-vs-branch-performance.txt`) |
| `e2e:soak` (10 seasons) | exit 1 in season 1: `authorized dynasty batch failed: no rows`. **Pre-existing**: identical on baseline main against the same DB; `get_dynasty_forecast_inputs` needs `dynasty_rankings` rows that neither the seed nor the fake upstream provides (`soak-season1-dynasty-batch-FAIL-preexisting.txt`). `e2e:soak:release` not attempted for the same reason |

Residual failures to fix in the next implementation phase (ordered):
1. `tests/db/waiver-claim-edit-gates.sql` fixtures (review B1, gating): add `waiver_priorities`; use limit 1 + consumed add.
2. `tests/e2e/harness-cleanup.mjs`: drop `trade_drop_reservations` (or derive the list from `pg_constraint`); re-run perpetual x2 + red-proof.
3. Review C1: `cdnGet` body read lost its overall timeout; S1 duplicate `roster_transactions` index (existing `(player_id, league_id, occurred_at desc)`); S2 migration comment (no predeploy build exists; prune is weekly); S3 dead trades empty branch (`listData` always has a header row); S4 Home error card precedes the live-draft card.
4. Soak on a fresh local stack needs a rankings fixture (environment gap, pre-existing).

Ambiguous league policies (unchanged, unresolved): edit = resubmission (`submitted_at`); trigger vs RPC
waiver-window predicate; FAAB reservation; offseason add-week numbering; Oct 1 season-year flip.

Local servers and the Supabase stack stopped; baseline worktree removed. Paused at a clean tree.

### Iteration 5 — 2026-09-12 (review round 1 fixes + deferred-candidate disposition, sandbox on)

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `01d8731` | Review B1: DB test seeds `waiver_priorities`, exhausts limit 1 via `consume_weekly_add`. C1: `cdnGet` overall 45 s deadline covers the body; `retry.ts` keeps the caller signal linked after headers. S1/S2: duplicate `roster_transactions` index removed, migration comment corrected. S3: dead trades empty branch removed. S4: `lib/home-surface.ts` precedence (draft > matchup > loading > error > empty). Cleanup list drops `trade_drop_reservations`; migration-scan test. Seed writes synthetic `hashtagbasketball.com` rows (ranks 9001+, `e2e-*`) so the soak dynasty check has candidates | `retry.test.ts` body-stall case FAILS on previous helper, 5/5 now; `tests/lib/home-surface.test.ts`; `tests/e2e-harness-fixtures.test.ts` 10 cases; DB test itself still needs the next local phase |
| `<this>` | Quick-add hook's unreachable waiver path removed; `editWaiverClaim` drop id explicit; roster-full message pinned; 14 dead type exports made local; README offseason add-week note | vitest 691; knip PASS |

Disposition of every deferred candidate (evidence-backed; "fixed" = in this branch, "DB phase" =
implementable but needs the local stack to test, "ambiguous" = docs/config do not settle it, left):

Roster / pickups / drops
1. Edge lineup-lock check bypassable via `activate_roster_player_with_overflow_atomic` (authenticated
   RPC calls `toggle_ir_atomic` without the Edge window) — real gap; the lock window itself is
   defined only in Edge (`assertRosterToggleUnlocked`, yesterday+12h) while the client uses today's
   tips (`lib/roster-locks.ts`). Which window is the rule is undocumented → **ambiguous**; DB-phase
   proposal: move the Edge window into a `private.assert_roster_toggle_unlocked` used by both.
2. UI shows expired-uncleared waiver hold as FA while the trigger blocks → **ambiguous** (trigger may
   be the intended backstop while claims are pending); unchanged.
3. Drop/IR of a pending claim's `drop_player_id` fails the claim later → **ambiguous** (block the drop
   vs fail the claim); unchanged.
4. Quick-add claim without drop on a full roster → **fixed**: the path was unreachable (Players
   routes waivers to the modal); removed so it cannot regress.
5. `editWaiverClaim` clears drop on omission → **fixed** at the type level (explicit `null`); RPC
   semantics (null = clear) unchanged.
6. Edit resets `submitted_at` → **ambiguous**; unchanged.
7. Edit skips create gates → **fixed** (`7ff4ab5`, test fixtures `01d8731`).
8. `create_waiver_claim_atomic` no roster projection / duplicate `claim_order` → **DB phase**
   (needs the processor tests); not changed.
9. Roster-full fallback by message substring → **pinned by test** (`roster-add-flow-message.test.ts`).
10. Offseason synthetic add weeks undocumented → **documented** (README).
11. Duplicated weekly-limit check in `process_next_waiver_claim_atomic` → **DB phase** refactor to
    `private.assert_weekly_add_available`; behaviour identical today, so not changed blind.
12. Trades bypass the roster cap → **intended** (roster-overflow recovery UI exists); no change.

Scheduled ops
1. Playoff `finalized_at` re-stamp → **fixed** (`2ec4589`), perpetual PASS.
2. Cron→edge fire-and-forget → **DB phase / design**: needs a `net._http_response` reconciliation
   into `sync_runs`; not changed.
3. Minute-exact ET gates skip on delay → **DB phase**: replace equality with a last-run watermark
   (pattern exists in `20260814000001`); scheduling semantics, so needs the harness.
4. Stats-range job parks after 3 failures → **ambiguous** (dead-letter policy undocumented).
5. Retry with aborted signal → **fixed** (`aea0e49`, `01d8731`).
6. Waiver notifications per batch → **fixed** (`0623e2c`).
7. Live-poll lease TTL 90 s vs work → **DB phase**: lease renewal mid-run; needs the stack.
8. Lineup-optimizer no cursor → **DB phase** (needs a persisted cursor column).
9. Boundary single-hour gate → same as 3.
10. Playoff snapshot backfill only regular season → **DB phase**; needs a failing scenario first.
11. Missed stats days after Final → **DB phase**; `count_final_games_missing_stats` exists unused.
12. Boundary failures recorded as success → **fixed** (`0623e2c`).

DB performance / dead code
- A1/A2 prune indexes → **fixed** (`20260912000001`, S1 duplicate removed). A3 → covered by an
  existing index (review S1). A4 lineup "added after" read → **DB phase** (index + limit).
- A5/A6/A7 N+1 in sync-players / playerResolver / draft-order → **DB phase**: batching changes insert
  semantics for missing ids; not changed blind.
- A8/A9/B4 redundant or unused indexes → **needs production `pg_stat_user_indexes`**; not changed.
- A10 `select('*')` → **fixed** (`0623e2c`). A11 trade-block unbounded → bounded by league size; a
  cap would be policy → unchanged. A12 realtime fan-out → unchanged (debounce exists).
- B1 dead type exports → **fixed** (14 removed). B2 ET helper triplication → generated copies with
  parity tests; consolidation touches the generator → deferred. B3 write-only
  `rookie_draft_scheduled_at` → product decision → **ambiguous**.

Remaining gates: (1) next local phase: `db reset`, `npm run test:db` (waiver-edit-gates must now
pass), perpetual x2 + `--disable-boundary`, `e2e:seed` (new dynasty fixture check), `e2e:soak`
(dynasty batch should return rows), browser chain, `perf:budget` gates; (2) independent re-review
of `main..HEAD`.

### Iteration 6 — 2026-09-12 (LOCAL TEST PHASE 3, sandbox temporarily off; evidence only, no code edits)

Stack from `8a3874f`: `supabase start` exit 0, `db reset` exit 0 (306 migrations; the three retained
indexes present, the removed duplicate absent). Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase4/`.

| Check | Result |
| --- | --- |
| `npm run test:db` (18 suites incl. `waiver-claim-edit-gates.sql`) | **PASS, exit 0** — all four gates refuse (B1 resolved) |
| `check:db-function-catalog` | PASS |
| `deno test --allow-all --no-check supabase/functions` | **exit 1: 112 passed / 1 failed** — `retry.test.ts` "a caller deadline aborts a body that stalls after headers" fails with `Leaks detected` (the 500 ms bounding timer added in `01d8731` is never cleared). Behaviour under test passes; the test's own timer leaks. **Residual: fix in the next implementation phase** |
| `e2e:perpetual` run1, run2 (same DB), `--disable-boundary`, run3 | PASS exit 0 / PASS exit 0 / **exit 1 with 4 boundary FAIL rows (correct negative control)** / PASS exit 0 — the FK-ordered cleanup holds across repeated runs |
| `pwa-update` main 2909a0a → branch 8a3874f | PASS exit 0 |
| `e2e:seed` | PASS; new check `dynasty_ranking_fixtures` PASS (80 synthetic rows from rank 9001) |
| Browser chain (16 scenarios incl. tab-only smoke and full sweep) | all exit 0 (`browser-chain-exits.txt`) |
| `perf:budget --require-report` / `--require-workflow-reports` | exit 1 after tab-only (no player-detail route), exit 0 after full sweep |
| Baseline vs branch (same host/league/stack) | shell paint 8.8→8.1 ms, mounted 34.5→32.6 ms, FCP 36→36 ms; workflow feedback 3.5/5→3.4/3.9 ms, full load 439/757→437/729 ms; initial JS 567.7 KB both; latency medians 9.5–19.7 → 8.4–17.7 ms. Within noise; no regression (`baseline-vs-branch-performance.txt`) |
| `e2e:soak` (ticks off) | exit 1: season 1 now PASSES (dynasty batch has rows), season 2 fails "active season did not advance" (season reset needs backend ticks; harness default). Configuration, not a regression |
| `soak.mjs --seasons=3` with backend ticks + fake upstream (`PLAYER_SYNC_SOURCE=sleeper` as in CI; edge env pointed at `host.docker.internal:4555`) | **PASS 3/3, exit 0** (first attempt without the source pin: "Sleeper delta=0", config) |
| `e2e:soak:release` (20 seasons) | **INTERRUPTED after ~15 min on operator request; no exit code; NOT a pass** (`soak-release-INTERRUPTED-partial.txt`) |

Executable probes on the deferred candidates (scratch SQL, rolled back; `probe-*.sql/.txt`):
- ops#3 minute-exact ET gates — **confirmed**: `invoke_edge_function_at_et_time` gate is `hour = p_hour AND minute = p_minute`; boundary gate `hour <> 9 → return`; a call outside the minute queues nothing (`net.http_request_queue` 0 → 0).
- ops#2 cron→edge fire-and-forget — **confirmed**: `invoke_edge_function` to an unreachable target leaves only a `net._http_response` row ("Couldn't connect to server"); `sync_runs` unchanged (1850 → 1850); only pg_net's own functions read `_http_response`.
- ops#11 Final game without stats — **confirmed**: `count_final_games_missing_stats(2026)` = 1 while the live-poll gate predicate is false and no cron job references that function.
- ops#7 live-poll lease — **confirmed**: holder A acquired, second caller refused inside TTL, no renew function exists, third caller took the lease after 91 s while A never released.
- ops#8 optimizer — **confirmed by schema**: `lineup_optimizer_settings` has no cursor column.
- ops#4 parked stats job — probe insert failed on this schema (`sync_jobs` metadata validation); the existing `stats-sync-jobs` DB test already proves the terminal cap; **resurrection path unverified** (no cron job calls `create_or_resume_stats_sync_job_atomic` — confirmed from `cron.job`).
- roster#8 claim projection/order — **confirmed**: on a 1/1 roster two claims with no drop and the same `claim_order` are both accepted as pending. Processing step returned 0 rows in the probe (processor needs the fuller fixture) — not exercised.
- roster#3 drop of a pending claim's drop player — **confirmed**: `drop_player_atomic` removes the player while the claim stays pending.
- roster#1 IR/taxi lock — **confirmed at DB level**: no DB function checks game status; `toggle_ir_atomic(IR→active)` succeeds during an in-progress game for the player's team. Which lock window is the rule (Edge yesterday+12h vs client today's tips) remains **ambiguous**; the DB-level gap itself is now evidence-backed.

Residual work for the next implementation phase (ordered): (1) clear the bounding timer in
`retry.test.ts` (Deno leak); (2) roster#1 shared lock assertion once the window is decided;
(3) ops#3/#2/#11/#7 have reproducible probes to drive fixes and DB tests; (4) roster#8/#3 need the
processor fixture to assert the failure path. Ambiguous league rules unchanged.

Local servers, fake upstream and the Supabase stack stopped; baseline worktree removed.

### Iteration 7 — 2026-09-12 (review round 2 + scheduling fixes, sandbox on)

Review round 2 preserved at `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase4/independent-review-round2.md`.

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `d7636b9` | B2: retry body-stall test clears its guard timer | `deno test retry.test.ts` 5/5, no leak |
| `bb84804` | S5 handlers re-raise unless the gate message fired; S6 comment names the real indexes; S7 comment order; S8 focus-gated reconnect/foreground refetch; S9 derived FK set test; S10 draft-order 45 s overall deadline; S11 no empty rows under a trades error banner | vitest 693; lint/typecheck/knip PASS |
| `<this>` | Scheduling: once-per-period catch-up (`cron_dispatch_state`, `claim_cron_dispatch`), durable `edge_invocations` + `reconcile_edge_invocations` cron, missing-stats live-poll gate, `renew_live_poll_lease` + edge heartbeat, optimizer least-recently-first ordering | DB tests written for each probe (unrun here); `leaseHeartbeat.test.ts` 3/3; wiring contracts; migration safety, parity, catalog manifest PASS |

Dispositions of the iteration-6 probe list:
- ops#3 missed minute/hour gates → **fixed** (`tests/db/cron-dispatch-catchup.sql` mirrors probe P1 with `p_now`).
- ops#2 cron HTTP failures without a durable result → **fixed** (`edge-invocation-reconcile.sql` mirrors P3).
- ops#11 Final game without stats → **fixed** (`live-poll-gate-and-lease.sql` mirrors P4).
- ops#7 slow live-poll lease → **renewal added** (same test); per-write fencing not added.
- ops#8 optimizer cursor → inspected: settings were unordered and the loop has no deadline, so
  starvation needs a platform kill mid-run; no run in the harness shows it. Chosen change: order by
  `last_optimized_at` asc nulls first (no schema), which makes any partial run resume at the tail.
- roster#8 / roster#3 claim processor → **investigated with a complete fixture**
  (`waiver-claim-projection.sql`): documents that both claims are accepted at create time, the drop
  of a pending claim's drop player is not guarded, and processing fails claim B with
  "Drop player is no longer on this active roster". No policy imposed.
- ops#4 parked stats jobs → unchanged (resurrection policy undocumented).

Remaining gates: (1) local phase: `db reset` (migration `20260912000003`, new cron job),
`npm run generate:database-types` then `check:database-types` (new tables), `npm run test:db`
(22 suites), Deno full run (expect 116/0), perpetual x2 + negative control, seed, tick-enabled
soak, browser chain, perf gates; (2) independent round-3 review of `main..HEAD`.

### Iteration 8 — 2026-09-12 (LOCAL TEST PHASE 4, sandbox temporarily off; evidence only, no code edits)

Stack from `09676e4`: loopback verified (API 127.0.0.1:54321, DB 127.0.0.1:54322), `db reset` exit 0
with **307** migrations, both new tables and the `edge-invocation-reconcile` cron job present.
Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase5/`.

| Check | Result |
| --- | --- |
| `node scripts/check-edge-functions.mjs` (CI exact, Deno 2.7.14 = CI pin) | **PASS 116/0, exit 0** (round-2 B2 resolved) |
| `deno test --allow-all --no-check supabase/functions` | PASS 116/0 |
| `check:db-function-catalog` | PASS (manifest matches the DB after the signature changes) |
| `npm run test:db` (22 suites, `&&` chain) | **exit 3, stops at suite 3**. Individually: 17 pass, 5 fail |
| … `dynasty-decision-inputs.sql`, `season-boundary-gate.sql` | **FAIL — regression from `c29e81c`**: both reference the old signatures `invoke_dynasty_ranking_views_at_et_time(integer,integer)` / `invoke_season_boundary_if_due()` via `regprocedure`, which the migration dropped |
| … `live-poll-gate-and-lease.sql`, `edge-invocation-reconcile.sql` | **FAIL — defect in the new tests**: psql `:var` used inside `DO $$` blocks (syntax error at `:`) |
| … `waiver-claim-projection.sql` | **FAIL — fixture defect**: `create_waiver_claim_atomic` says "This player is no longer on waivers" at case A (window predicate not met by the fixture as written); needs investigation |
| … `waiver-claim-edit-gates.sql`, `cron-dispatch-catchup.sql` | PASS; catch-up notices recorded (late tick 1, same-day repeat 1, next day 2, weekly Tuesday catch-up 3, no double, next Monday 6, boundary late tick 1, repeat 1) |
| Negative proofs (old bodies installed in the rolled-back test transaction) | `waiver-claim-edit-gates` vs main's function: **red** at case 2 ("Drop player must be on your active roster."); scratch copy without case 2 vs main: **red** at case 3 with the re-raised "expected closed-window edit to be refused" (nothing swallowed); same copy vs new: exit 0. `cron-dispatch-catchup` vs old fire-and-forget `invoke_edge_function`: **red** ("late tick did not catch up"). vs old minute-exact gates: **not provable this way** (old gates lack `p_now`; overloads coexisted) — the real-clock probe P1 remains the evidence |
| `e2e:perpetual` run1, run2, `--disable-boundary`, run3 | PASS / PASS / **exit 1 with 4 boundary FAIL rows** / PASS |
| `e2e:seed` | PASS incl. `dynasty_ranking_fixtures` |
| Browser: smoke (tab-only), perf, data-latency, lineup, waiver, waiver-drop, trade, full-sweep smoke | all exit 0; `perf:budget --require-report` and `--require-workflow-reports` exit 0 |
| `e2e:browser-pwa-launch` | **FAIL exit 1 on 4 branch runs and on baseline main** (same host/seed): `firstContentfulPaintMs=null`; shell paint 7–11 ms and app mounted 32–38 ms recorded. The `first-contentful-paint` entry is absent on this host session (it was 36–44 ms in phases 2–4). Environment, preserved as a failure |
| `soak.mjs --seasons=3` with ticks + fake upstream | PASS 3/3, exit 0 |
| `supabase gen types typescript --local` | generated into scratch; 170-line diff vs `types/database.ts` saved as `database-types.generated.diff` (two new tables, `p_now` args, plus pre-existing nullability drift) — to apply once the sandbox is back on |
| `e2e:soak:release` | not run (known fixes pending) |

Fix queue for the next implementation phase (ordered): (1) keep zero/two-argument overloads (or update the
two existing DB tests) for the changed cron gate signatures; (2) `:var` → `current_setting` in the two
new DB tests; (3) `waiver-claim-projection.sql` fixture vs the create window predicate; (4) apply the
generated types diff; (5) `check:database-types` and re-run `npm run test:db`. Ambiguous league rules
unchanged. Local jobs and the Pancake stack stopped; baseline worktree removed.

### Iteration 9 — 2026-09-12 (phase-5 repairs + review round 3, sandbox on)

Review round 3 preserved at `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase5/independent-review-round3.md`
(33 survivors; item 10 — RLS on the two new tables — deferred as a security item, not addressed here).

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `b59c3e2` | Five DB-suite failures repaired (signature references in two existing suites + security catalog + grants test; `set_config`/`current_setting` in two new suites; waiver fixture vs the 48 h trigger); `cron-dispatch-catchup.sql` now EXECUTEs every scheduled ET-time cron command and adds EDT + rollback-on-raise cases; live-poll test no longer deletes real games and adds a "Final with stats does not wake" case. `types/database.ts` rebuilt from the saved raw output through the repo generator's post-processing (+67/−7). Round-3 items 1–9, 11–17, 19, 23–29, 31–32 applied (see commit body). FCP gate keeps `null` as unknown and records paint diagnostics | vitest 699; lint, typechecks, knip, edge-shared, db-function-sources, catalog order, surface matrix PASS; Deno sandbox run fails only the 8 listen-denied suites. DB suites and `check:database-types` need the next local phase |

Not changed (review notes only): #18 (30 s pg_net timeout may log a failed `cron:` row for a long run),
#20 (update check can reload mid-task; documented behaviour), #21 (an edge throw plus reconcile can yield two
failed rows), #22 (`configured-source-health` does not read `cron:*` rows), #30 (some tests are source
contracts), #33 (pre-existing edit/create lock order). Ambiguous league rules unchanged.

Next local phase: `db reset` (307 migrations), `check:database-types` (expect clean), `npm run test:db`
(22 suites, chain must complete), negative proofs against old bodies, perpetual x2 + negative control,
browser chain with the PWA launch diagnostics captured, tick-enabled soak; then round-4 review.

### Iteration 10 — 2026-09-12 (LOCAL TEST PHASE 5, sandbox temporarily off; evidence only, no code edits)

Stack from `c34c33c`: loopback verified, `db reset` exit 0 (307 migrations), deploy-day
`cron_dispatch_state` seed rows present. Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase6/`.

Verified this phase:
| Check | Result |
| --- | --- |
| `check:database-types` | **PASS exit 0** (generator parity after the rebuild) |
| `node scripts/check-edge-functions.mjs` (Deno 2.7.14) / full Deno | **PASS 117/0** both |
| `check:db-function-catalog` | PASS |
| `npm run test:db` (22-suite chain) | **exit 3 — 21 pass, the 22nd (`waiver-claim-projection.sql`) fails at its own assertion**: the processor returns `failed_roster` + "Drop player is no longer on this active roster." (exactly the documented behaviour) but the test compares to the literal `failed`, which is not a `waiver_claim_status`. Test defect; **material gate red → release soak not run** |
| Negative proofs (old bodies in the rolled-back txn) | waiver-edit vs main: red (case 2); cases 3–5 scratch vs main: red with the re-raised "expected closed-window edit to be refused"; cron-dispatch vs old fire-and-forget invoke: red ("late tick did not catch up"); live-poll gate vs old gate: red ("a Final game without stats did not wake live-poll (got 0)"); all four green on the new code. Reconcile vs old invoke is not a negative case (test seeds `edge_invocations` directly) |
| `cron-dispatch-catchup.sql` | 5 scheduled ET-time cron commands executed against the current signatures; EDT and rollback-on-raise cases green |
| `e2e:perpetual` x2, `--disable-boundary`, run3 | PASS / PASS / **red with 4 boundary FAIL rows** / PASS |
| Browser (branch): pwa-launch, smoke, perf, data-latency, lineup, waiver, waiver-drop, trade, full-sweep smoke | all exit 0; `perf:budget` both gates exit 0 |
| PWA launch FCP | **real paint evidence recovered**: branch FCP 40 ms, baseline 32 ms (both PASS) after starting from a closed browser session; the phase-5 nulls stay recorded as failures |
| Baseline vs branch | within noise (`baseline-vs-branch-performance.txt`) |
| Tick-enabled soak (3 seasons, fake upstream, sleeper source) | PASS 3/3 |
| `e2e:soak:release` (20 seasons) | **NOT RUN** (gate red above); still an unfinished release gate |

Fix queue: (1) `tests/db/waiver-claim-projection.sql` — assert `failed_roster` (enum) instead of `failed`.
Deferred notes unchanged (round-3 #10 RLS, #18, #20–22, #30, #33). Ambiguous league rules unchanged.
Local jobs and the Pancake stack stopped; baseline worktree removed.

### Iteration 11 — 2026-09-12 (narrow fix, sandbox on)

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `<this>` | `tests/db/waiver-claim-projection.sql`: expected status `failed_roster` (the only failure value `process_next_waiver_claim_atomic` writes; `waiver_claim_status` has no `failed`), reason assertion unchanged. `tests/e2e/README.md`: launch runs start from a closed `agent-browser` session; a missing paint entry stays unknown | Static checks only; **the corrected SQL has not been executed** — next local phase must run `npm run test:db` (22/22 expected) and then the 20-season release soak |

Current state at this checkpoint:
- Verified on the local stack (phase 5, `766d126` evidence): types parity, CI edge 117/0, 21/22 DB suites,
  negative proofs, perpetual x3 + negative control, browser chain + perf gates with real FCP (40 ms
  branch / 32 ms baseline, single samples, no speedup claimed), tick-enabled 3-season soak.
- Not yet verified: this test fix; the full 22/22 chain; `e2e:soak:release` (unfinished release gate).
- Deferred notes: round-3 #10 (RLS on `cron_dispatch_state`/`edge_invocations`, security), #18, #20–22,
  #30, #33. Round-4 review pending on `c34c33c`. Ambiguous league rules unchanged.

### Iteration 12 — 2026-09-12 (review round 4, sandbox on)

Round 4 preserved at `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase6/independent-review-round4.md`
(13 survivors). Item 1 (gating, enum literal) was fixed in `c18c6b8`. Items 2–9, 12, 13 applied in
`677a866` (see commit body). Round-4 item 10 (the deploy-day seed can skip one catch-up on deploy day
if the old gate had missed that day; fails safe, runs once, a day late) is noted, not changed. Round-4
item 11 (a lost lease also writes a failed `cron:live-poll` row) noted as intended noise. RLS on the two
new tables is round-3 item 10, carried and still deferred as security; it is a different item.

Current state:
- Verified on a local stack (phase 5, `766d126`): types parity, CI edge 117/0, 21/22 DB suites, four
  negative proofs, perpetual x3 + negative control, browser chain + perf gates with real FCP, tick soak.
- Unverified since then (static checks only): the claim-projection enum fix, the round-4 batch
  (hooks, optimizer sync_runs, live-poll decision/backoff, DB test changes). Next approved phase:
  `db reset`, `check:database-types`, `npm run test:db` (22/22 expected), CI edge checker, perpetual
  x2 + negative, browser chain, tick soak; only then `e2e:soak:release` (still unfinished).
- Deferred notes: round-3 #10 (RLS, security); round-3 #18, #20–22, #30, #33; round-4 #10 (deploy-day seed
  skip) and #11 (lost-lease failed row). Ambiguous league rules unchanged.

### Iteration 13 — 2026-09-12/13 (LOCAL TEST PHASE 6, sandbox temporarily off; evidence only, no code edits)

Stack from `1a98fc2`. Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase7/`. Independent review
round 5 (APPROVE, 10 residuals) preserved there; none of its residuals were changed in this phase.

Verified (real runs, exit codes preserved):
| Check | Result |
| --- | --- |
| `db reset` 307 migrations; `check:database-types` | PASS exit 0 |
| `npm run test:db` (22-suite chain) | **PASS exit 0, 22/22** — claim-projection enum fix exercised (`failed_roster` + reason) |
| `check:db-function-catalog` | PASS |
| CI edge checker (Deno 2.7.14) / full Deno | **PASS 121/0** both |
| Negative proofs (old or broken bodies in the rolled-back txn) | waiver-edit vs main red; cases 3–5 vs main red (re-raised); cron catch-up vs old invoke red; live-poll gate vs old gate red; **live-poll vs a stats-ignoring gate red** ("a Final game that has its stats woke live-poll again"); all green on new code |
| Runtime scenarios against the live functions | live-poll: Final game without stats → sync attempted, CDN 403 for the synthetic box score → 500, attempt stamped, next tick `idle` (backoff); lease held by another holder → `lease-skip`, expired → proceeds. **Optimizer real partial failure**: one member over the active limit + one healthy → `optimized 1, failed 1`, `sync_runs` row `failed` with "1 of 2 enabled member(s) failed auto-set", healthy lineup written, both settings touched (first attempt with a game outside the seeded week was `dates=0`, recorded as not evidence) |
| `e2e:perpetual` x2, `--disable-boundary`, run3 | PASS / PASS / red with 4 boundary FAIL rows / PASS |
| Seed; browser chain (15 recorded commands, then the full-sweep smoke) from a closed browser session; full sweep; `perf:budget` both gates | all exit 0; branch pwa-launch FCP 52 ms, baseline 48 ms (single samples) |
| Baseline vs branch | recorded as single samples with direction only; every metric slower on the branch in this sample; run order (branch first, cold) confounds it; significance unknown (`baseline-vs-branch-performance.txt`) |
| Tick-enabled soak (3 seasons) | PASS 3/3 |
| `e2e:soak:release` attempt 1 (bound 7200 s, `E2E_ENABLE_MIDLIFE_MIGRATION=0`) | **STOPPED by me (SIGTERM) after season 1** (1128 s from the start line to the first season-2 artifact; the log spans 1176 s) to re-bound; season-1 scenario summaries all PASS; captured exit 143 (128+SIGTERM); not a pass |
| `e2e:soak:release` attempt 2 (bound 36000 s, sessions closed first, `E2E_ENABLE_MIDLIFE_MIGRATION=0`) | **FAIL exit 1**: seasons 1 and 2 completed all 23 browser scenarios (artifacts to 02:06Z); season 3 wrote 22 scenario entries and failed at its pwa-launch (02:23Z) with `fcp=unknown`, diagnostics `paintEntries=[] visible focused paintTimingSupported=true`. The report's `ERROR 0/20, season 0` is the harness fallback counter, not the failure point. Material gate red; not retried |

Release gate status: **unfinished and currently red** on a missing paint entry, seen with and without a
fresh browser session and intermittent: the same run passed pwa-launch in seasons 1 and 2 and lost every
paint entry in season 3. Seen on baseline main too (phase 5), so not introduced by this branch; cause
unknown (engine output or late-reader measurement); the paint probe is the pending diagnosis. The
release-soak attempts ran with `E2E_ENABLE_MIDLIFE_MIGRATION=0` (see iteration 19), so even a green run
would not have satisfied the release gate's required `long.migration` row.

Local jobs and the Pancake stack stopped; baseline worktree removed. Ambiguous league rules unchanged.

### Iteration 14 — 2026-09-12 (approved diagnosis cycle, sandbox on; diagnostic code only)

Per `.forge-approved-cycle.md`. Season-3 evidence re-read: shell mark 6.8 ms and app mount 29.8 ms were
recorded, while `getEntriesByType('paint')` was empty on a visible, focused document with paint timing
supported. The retained `relaunch.png` is a print capture, not proof of an on-screen paint; whether a
paint happened is unknown from that evidence — only that no `first-contentful-paint` entry reached that reader.

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `<this>` | `tests/e2e/pwa-paint-probe.mjs` (+ `npm run e2e:pwa-paint-probe`): 20 launches, alternating FRESH (all sessions closed first) and REUSED sessions, signed-in relaunch of `/roster` like the gate; per launch records paint entries via `getEntriesByType` and via a buffered `PerformanceObserver`, boot marks, visibility, focus, readiness, navigation type, user agent, screenshot. Product gate kept (FCP present and ≤ 400 ms; missing = FAIL); no filtering, no retry; exit 1 on any failure. README documents it | `tests/e2e-pwa-paint-probe.test.ts` (allocation + gate); lint, `typecheck:e2e`, knip PASS. Not executed here (needs the local browser phase) |

Probe run plan for the approved local phase (exact commands, from the repo root with the private local env loaded):
1. `supabase start` → `node <scratch>/write-local-env.mjs` → `. <scratch>/local.sh` → `supabase db reset`
2. `supabase functions serve --env-file <scratch>/functions.env --no-verify-jwt &`
3. `npx expo export --platform web --clear && node scripts/stamp-release-provenance.mjs`
4. `npm run e2e:seed`; `node tests/e2e/static-web-server.mjs --root=dist --port=8081 &`
5. `npm run e2e:pwa-paint-probe -- --launches=20` (≈ 20 × ~40 s; the probe owns and closes only its own sessions)
Sample allocation: 10 fresh + 10 reused, interleaved. Conditions: same host, same build, same seeded user,
3 s settle after navigation, one measured navigation attempt per launch (setup sign-in attempts are
counted separately), one screenshot per launch. All 20 results are retained whatever they show.
Decision after the run: if FCP is missing from `getEntriesByType` but present via the buffered observer,
the repair is measurement-only in the launch scenario; if missing from both late readers while marks and screenshot
show paint, the result is 'no-late-reader-evidence' — an eviction/buffering cause cannot be excluded
because agent-browser 0.25 has no pre-navigation init script, so no engine-no-data conclusion is drawn
and the next step is an early-observer capability (or a different engine/host) decision; if present everywhere, the season-3 failure is a rare intermittent to keep
sampling. Then independent review, then the complete 20-season run under a 36,000 s bound.

### Iteration 15 — 2026-09-12 (probe corrections per `.forge-probe-corrections.md`, sandbox on)

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `<this>` | Probe corrections: (1) no global `agent-browser close --all`; fresh launches use a probe-owned session closed individually, one reused probe-owned session lives across all reused launches and is closed at the end; README/WORKLOG setup no longer close other sessions. (2) The measured navigation is exactly one attempt; sign-in setup may retry and its attempts are recorded per launch (`setupAttempts`, `measuredNavigationAttempts`). (3) `judgeLaunch` treats anything but a finite number ≥ 0 as missing; `parseCount` requires a finite positive integer; `parseWaitMs` a finite number ≥ 0. (4) agent-browser 0.25 has no pre-navigation init script, so both readers are late; an empty result is labelled `no-late-reader-evidence` and no engine-no-data conclusion is drawn (code, report, README, decision rule updated). (5) The probe asserts a loopback Supabase endpoint before signing in, not only the frontend | `tests/e2e-pwa-paint-probe.test.ts` 4 cases incl. NaN/undefined/Infinity/negative timing and 0/-1/1.5/NaN/Infinity counts; lint, `typecheck:e2e`, knip PASS. Not executed here |

### Iteration 16 — 2026-09-13 (LOCAL TEST PHASE 7: paint probe run 1, sandbox temporarily off; evidence only)

Setup on the loopback stack from `cf5cd5b`: `db reset` 307, functions healthy, release build stamped, seed
PASS, static server up; the one pre-existing browser session on the host was not touched.
Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase8/`.

| Check | Result |
| --- | --- |
| `npm run e2e:pwa-paint-probe -- --launches=20` | **exit 1 after 0.25 s — 0 of 20 launches measured, 20 probe errors**: `Cannot own browser session <name> without an active scenario resource owner`. `createBrowser()` only lends sessions inside `runWithScenarioResourceOwner`, which every scenario wraps around its run and the probe did not. Probe setup defect; **no paint measurement exists from this run and no engine conclusion is drawn** |

Repair for the next implementation phase (sandbox on): wrap the probe's `main()` in
`runWithScenarioResourceOwner` (as `browser-pwa-launch.mjs` does), keep everything else as corrected in
`cf5cd5b`, add a unit test that the probe entry point acquires a resource owner, then re-run the same
20-launch plan. Own processes and the Pancake stack stopped.

### Iteration 17 — 2026-09-13 (probe repair after phase-8 run 1, sandbox on)

| Commit | Change | Test / evidence |
| --- | --- | --- |
| `<this>` | Probe entry point wrapped in `runWithScenarioResourceOwner` (`runPaintProbeEntry`), browser injected (`browserFactory`) so the ownership contract is exercised in tests; `openCdpClient` exported from `browser-agent.mjs`; early reader registered per session before the measured navigation via `Page.addScriptToEvaluateOnNewDocument` (capability-tested, outcome recorded per launch); `judgeLaunch` distinguishes "early observer saw it / saw none / not installed"; report and README updated. Sessions, single measured navigation, 400 ms gate and missing-timing failure unchanged | `tests/e2e-pwa-paint-probe-entry.test.ts`: the probe fails outside an owner with the phase-8 message and, under the wrapper, measures every launch, owns one reused session, closes exactly its own sessions, never uses `--all`; early observer registration and its no-endpoint path; `tests/e2e-pwa-paint-probe.test.ts` gate/allocation. Not executed against a browser here |

Early-observer support is not asserted from the missing agent-browser init flag: it is tried through CDP on
every launch and the result is data. Phase-8 run 1 (0/20, probe defect) stays recorded.

### Iteration 18 — 2026-09-13 (LOCAL TEST PHASE 8: paint probe run 2, sandbox temporarily off; evidence only)

Setup from `c8945c4` green (307 migrations, functions 200, stamped build, seed, static server; the host's one
pre-existing browser session untouched). Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase9/`.

| Check | Result |
| --- | --- |
| `npm run e2e:pwa-paint-probe -- --launches=20` | **exit 1, 17:33 wall — 0 of 20 launches measured, 20 probe errors**: `Expected property name or '}' in JSON at position 1` on each launch's first `eval` (sign-in setup). The phase-8 owner defect is gone (sessions were created, opened and driven). **No paint measurement exists; no engine conclusion.** |
| Raw eval diagnosis (one probe-owned diagnostic session, opened → evaluated → closed) | agent-browser prints the eval result as a JSON-encoded string (`"{\"path\":\"/sign-in\",\"text\":605}"`, byte view retained). The launch scenario's parser (last line, parse, parse again if string) decodes it; the probe's parser (slice from the first `{`) fails at position 1 on the same bytes |

Repair for the next implementation phase: replace the probe's `parseEvalJson` with the scenario's, add an
executable test using the retained raw sample, keep everything else. Phase-8 run 1 (owner defect) and this
run 2 (parser defect) are both retained as separate failures. Own processes and the Pancake stack stopped.

### Iteration 19 — 2026-09-13 (review round 6 repairs, sandbox on; no servers run)

Round 6 preserved at `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase9/independent-review-round6.md`
(APPROVE is code-only; the probe still had to be repaired before it can measure anything). All 26 items:

| # | Disposition |
| --- | --- |
| 1 | **Fixed**: `parseEvalJson` = last non-empty line, parse, parse again if string; `tests/fixtures/agent-browser-eval-sample.txt` is the phase-9 raw bytes and is decoded in a test; the entry test's fake double-encodes every eval |
| 2 | **Fixed in code, verified on real Chromium by review 7** (registered, ran, script removed after `finish()`). The *order* in `runPaintProbe` (finish after the read, before the close) is not pinned by a test — review-7 item 3, open. Original text: `beginEarlyObserver` keeps the CDP client attached through the measured navigation and read; `finish()` removes the script then closes; `earlyObserver.ran` is true only when the page exposed the store; verdict buckets (`BUCKETS`, 8) are exhaustive and exclusive and the summary is derived from them; tests cover attach/remove/close order and ran-vs-registered |
| 3 | **Partly fixed** (review-7 item 2): the gate paragraph was corrected, but the `relaunch.png` sentence was not dropped until iteration 22. Original text: gate paragraph now says seen on main too, cause unknown (engine or late-reader measurement), probe pending; `relaunch.png` citation dropped |
| 4 | **Fixed**: the probe runs the gate's prelude verbatim (signed-out `/`, cleared relaunch, 2500 ms, sign-in, 2000 ms) before the measured `/roster`; reused launches skip it after the first and the record says so |
| 5 | **Fixed**: setup attempts ride on the thrown error and land in the record; test asserts 3 on a failed setup |
| 6 | **Fixed**: the fake releases only after a successful close, has a real dispose, and a test makes a fresh close fail (record gets `closeError`, the entry rejects with the owner's cleanup error after the report is on disk) |
| 7 | **Mostly fixed** (review 7: five of six named mutations killed; the reused-prelude mutation survives — review-7 item 5, open). Original text: tests now fail on a retried measured open, on a fresh session left open, on `early-none` passing, on a hardcoded "not registered" (the probe must ask for `cdp-url`), on the reused session re-running the prelude, and on shared fresh names; a signed-in entry test exists |
| 8 | **Partly fixed**: `pathToFileURL` handles spaces; a symlinked `argv[1]` still skips main and exits 0 (review-7 item 8, open, pre-existing). Original text: fixed in the probe (`pathToFileURL`); the 27-file sweep is left as a separate tracker |
| 9 | **Fixed** by the exclusive buckets (`early-saw` precedes late-observer checks; nothing counts twice) |
| 10 | **Fixed**: `store.error` becomes bucket `missing:early-error` |
| 11 | **Fixed**: "browser CDP endpoint" in code and README |
| 12 | **Fixed** (review 7 final: the screenshot-as-proof header sentence is a separate nit, item 26, open). Original text: header rewritten (own sessions, three readers, counted setup retries) |
| 13 | **Recorded** (review 7 final: attempt 2's report proves its flag; no retained file shows attempt 1's flag — item 12, open). Investigated: both release attempts ran with `E2E_ENABLE_MIDLIFE_MIGRATION=0` and could not have satisfied `long.migration`; the evidence files and the gate paragraph say so. README now documents the local mid-life procedure (stack on the deployed schema `20260823000001` with the three branch migrations moved aside, `E2E_MIDLIFE_EXPECTED_*` from `release-soak-migration-plan.mjs`, `E2E_ENABLE_MIDLIFE_MIGRATION=1`, push at the season-5 boundary). Not run here |
| 14 | **Fixed**: `--launches 20` form accepted, bare flag refused, `[::1]`/`::1` loopback accepted (tests) |
| 15 | **Fixed**: temp dirs removed in `afterEach` |
| 16 | **Fixed**: WORKLOG and attempt-1 file state 1128 s (start to first season-2 artifact) vs 1176 s log span |
| 17 | **Fixed**: the two unlabelled lines in the attempt-2 file are labelled as wrapper text |
| 18 | **Not fixed at 24d4768** (the WORKLOG still said "16 scenarios"; the quoted phrase existed nowhere — review-7 item 2). Corrected in iteration 22 |
| 19 | **Fixed**: budget gates ran on the branch only; stated |
| 20 | **Fixed**: merged numbers re-laid out |
| 21 | **Fixed**: README no longer claims the closed-session recovery; it records the intermittent evidence |
| 22 | **Partly fixed**: header added, but the file's line 5 still said "ANY Final game" against it (review-7 item 11); corrected in iteration 22. Original text: scratch SQL carries a negative-proof header and states it wakes on any game |
| 23 | **Partly fixed**: `negative-proofs.txt` was corrected; `soak-ticks.txt` was not touched (review-7 item 2); corrected in iteration 22. Original text: `soak-ticks.txt` and `negative-proofs.txt` say what was captured and what was not retained |
| 24 | **Not fixed** (review-7 item 1, verified): the handler runs outside the scenario owner, so every close throws and is swallowed; exit 130; no `close` reaches agent-browser. Open. Original claim: SIGINT/SIGTERM close the probe-owned sessions before exit (the gate's same gap is a tracker) |
| 25 | **Fixed**: `openCdpClient` closes the socket on connect timeout or error |
| 26 | **Fixed**: fresh session names carry a per-run random tag plus the launch index; test asserts distinct names |

Carried unchanged: round-5 items 1–10, round-4 items 10 and 11, round-3 items 10 (RLS, security, deferred),
18, 20, 21, 22, 30, 33. Phase-8 run 1 and phase-9 run 2 remain recorded as separate probe failures.

Checks: vitest 123 files / 719 tests; lint, `typecheck:e2e`, `typecheck:tests`, knip PASS. Not executed
against a browser or database here. Next approved local phase: the 20-launch probe
(`npm run e2e:pwa-paint-probe -- --launches=20`), then — only with a diagnosis in hand — the release
soak with the mid-life migration gate configured as documented, never with it disabled.

### Iteration 20 — 2026-09-13 (local phase 10, test-only, sandbox off; evidence in `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase10/`)

Stack at `24d4768`: `supabase start` + `db reset` (307 migrations), `functions serve`, stamped `build:web:release`, `e2e:seed`, static server on 127.0.0.1:8081. Loopback asserted before every mutating step. No implementation edits.

| Run | Result |
| --- | --- |
| Probe run 3, `npm run e2e:pwa-paint-probe -- --launches=20` (default agent-browser engine, HeadlessChrome/147.0.0.0), 04:16:01–04:19:56Z | **FAIL: 20 launches failed, 0 passed, exit 1.** Every launch bucket `missing:early-none`: the early observer registered *and ran* on all 20, from document start, and saw no `paint` entry; `getEntriesByType` and the late observer also empty; shell mark 6–11 ms, mount 25–38 ms, document visible and focused. The per-launch screenshots are CDP print captures of the rendered signed-in Roster page: they prove the renderer produced the pixels for capture, not that an on-screen paint (or a paint-timing event) occurred. "setup attempts 3" on fresh rows = the three prelude opens, one attempt each (no retries); the column label is ambiguous and is a doc nit for the next sandbox-on phase. |
| Browser-mode inspection (session-local flags/env only; `browser-paint-modes.txt`) | Default engine = agent-browser's bundled Chrome for Testing 147.0.7727.56 (also .117 present): **no paint entries** in headless, `--headed`, with GPU/ANGLE `--args`, and even for a trivial static `<h1>` page. Session-local `--executable-path` to system Google Chrome (HeadlessChrome/152) and to Playwright's `chrome-headless-shell` 1243 (HeadlessChrome/153) **both emit first-paint/first-contentful-paint** on the trivial page and on `/sign-in`. No global agent-browser config was changed (none exists). |
| Probe run 4 (**display confound, from review 7's coverage caveat**: a reviewer's `caffeinate -u` woke the display 21:24:56–~21:25:26 PDT, covering launch 1; a display-sleep assertion of unknown origin held until 21:28:30, covering launches 2–20 — so this is neither a clean display-off nor display-on sample; the reviewer's own later Chrome 153 sessions with the display off still painted), same command with `AGENT_BROWSER_EXECUTABLE_PATH=~/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell` (reports HeadlessChrome/153.0.8010.12) for that process only, 04:25:10–04:28:27Z | **PASS 20/20, exit 0.** FCP 12–24 ms on every fresh and reused launch; early observer, byType and late observer all agree (2 entries each); shell 4.6–10 ms, mount 25–38 ms. The 400 ms budget and the missing-timing failure rule were not changed. |

Diagnosis: the missing `first-contentful-paint` is a property of the browser engine the harness launches by default (agent-browser's bundled Chrome for Testing 147), not of the app: the same build, same prelude and same route renders for capture (screenshots) but reports no paint-timing entries, while two other Chromium builds report them on every launch. Earlier intermittent passes on this host were therefore engine-version dependent; CI gets its engine the same way (`npm ci`, agent-browser downloads its own Chrome for Testing), so the gate's engine is not pinned by the repository. Not a fix: choosing the engine for the gate is a harness/CI decision for the next sandbox-on phase (candidates: pin `AGENT_BROWSER_EXECUTABLE_PATH` in the release workflow and README, or record the engine in the launch-gate report and fail with an explicit "engine emitted no paint entries" reason). Left unresolved and red until then.

Mid-life migration route (review-6 item 13; `midlife-migration-local-route.txt`): verified on isolated copies under the session scratch dir with the repository's `supabase/migrations` untouched (307 files before and after). Base copy (304 files, newest `20260823000001`) reset → head `20260823000001`, new tables absent; the harness's own `supabase db push --local --yes` from the repo root applied exactly `20260912000001..3` → head `20260912000003`, tables present; a second push was a no-op; `validateAppliedMigrationDelta` returns the three versions with no failures; repeated on a seeded league with data counts unchanged across the push. Git proof: main `2909a0a` newest migration is `20260823000001`; the branch adds exactly the three. Not proven: the production schema head (no remote query in this phase) and the boundary under five seasons of soak data. The README's "move files aside" wording should become "reset from a base-schema copy" in the next sandbox-on phase so no implementation migrations are moved.

Shutdown: own `functions serve` and static-server pids killed, `supabase stop` exit 0, no pancake containers, no `pwa-*` agent-browser sessions listed, no global browser close. Not run: the 20-season release soak (paint engine choice and mid-life wording pending). Independent review round 7 is running separately; nothing here is self-approved.

### Iteration 21 — 2026-09-13 (sandbox on; readiness docs only, no servers)

- Run-3 wording corrected above: 20 launches failed, 0 passed (not "0/20 failed"); screenshots are print captures, not proof of an on-screen paint. Both raw reports (run 3 default engine, run 4 headless shell) are retained in `local-phase10/`.
- README: the launch gate and the paint probe now document the verified process-local engine, `AGENT_BROWSER_EXECUTABLE_PATH` set on the command only, with the exact executable and the version it reported (Playwright `chromium_headless_shell-1243` → HeadlessChrome/153.0.8010.12; system Google Chrome → HeadlessChrome/152 also emitted entries; the bundled Chrome for Testing 147.0.7727.56 and .117 did not). No global agent-browser config, no model, and no CI change: CI pinning is not evidence-backed until a CI run shows the same engine defect, so it is recorded as a candidate, not applied.
- README mid-life section rewritten to the tested route: reset from a base-schema copy (304 files, head `20260823000001`), run the release soak from the repo root, the harness pushes to 307 (`20260912000003`) after season 5. No repository migration is moved. The local base is the newest migration on main; it is not production verification (CI derives the base from the linked project's `schema_migrations`).
- Probe report column renamed from "setup attempts" to "setup opens (attempts, 3 = one per prelude page)" — label only; the counter is unchanged.
- Next approved local phase: the full 20-season gate with the mid-life check enabled, exact command in the README section, under a 36000 s bound with the child's real exit status captured; a shorter soak is not a substitute.

### Iteration 22 — 2026-09-13 (review round 7 dispositions; sandbox on; no servers)

Round 7 (APPROVE, 27 survivors: 9 minor, 18 nit, none gating) preserved at
`docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase10/independent-review-round7.md`. Its central
finding is that iteration 19's record overclaimed: items 18 and 24 were marked Fixed and were not; items 2, 3, 7, 8,
12, 22 and 23 were partly true. The iteration-19 rows are now relabelled in place with the original text kept.
Only the text corrections that those false rows claimed are applied here (no code repair sweep):

- `WORKLOG` phase-7 row: "browser chain (16 scenarios)" → "15 recorded commands, then the full-sweep smoke" (item 2 / round-6 #18).
- `WORKLOG` season-3 paragraph: `relaunch.png` no longer cited as proof that "the paint happened" (item 2 / round-6 #3; item 26).
- `local-phase7/soak-ticks.txt`: states what was captured and what was not retained (item 2 / round-6 #23).
- `local-phase7/scratch-stats-ignoring-gate.sql` line 5 aligned with its header (item 11 / round-6 #22).

All 27 findings are retained as open unless stated: 1 (signal handler closes nothing; exit 130), 3 (finish order
untested), 4 (README recipe lacked seed/prerequisites — the iteration-21 README block now seeds and names the
executable; functions serve and the static release build are still prerequisites, added below), 5, 6, 7, 8, 9
(**display-state lead**: every recorded paint pass fell with the display on and both recorded misses with it off,
Chrome 147; a correlation, not a proven cause — run the next soak on the named engine under `caffeinate -d` and
record user agent plus display state), 10, 12–25, 27. Item 9 and the run-4 confound above mean phase 10's
engine diagnosis rests on the plain-page and executable comparisons, which were run in the same host state; a
clean display-on vs display-off matrix does not exist yet.

Carried unchanged: round-5 1–10, round-4 10–11, round-3 10 (RLS, security, deferred), 18, 20, 21, 22, 30, 33.

### Iteration 23 — 2026-09-13 (review 7 final copy; then LOCAL TEST PHASE 11, the full 20-season release gate)

`.forge-review7-final.md` (APPROVE, exit 0; same 27 findings; an independent judge checked about 70 citations) is
preserved at `local-phase10/independent-review-round7-final.md`. Changes from the draft, applied to the iteration-19
rows above: item 12 is fully Fixed (the screenshot sentence is nit 26 on its own); item 13 is "Recorded", not fixed
(attempt 1's flag has no retained proof, nit 12); item 22 is explicitly among the partly-true rows, so five rows are
partial (3, 7, 8, 22, 23) and two are false (18, 24). No repair sweep. All 27 findings stay open as listed in
iteration 22.

### Iteration 24 — 2026-09-13 (LOCAL TEST PHASE 11: the complete 20-season release gate with the mid-life migration enabled; sandbox off for the run, evidence only; committed with sandbox on)

Evidence: `docs/evidence/2026-09-12-hardening-t_a4dc0293/local-phase11/`. Commit under test `9fa03e2`. Every endpoint loopback (asserted by the run script before anything mutating). Stack: `supabase start`; **fresh base-schema copy via `mktemp -d` (304 migrations, head `20260823000001`), `supabase db reset` from that copy, verified count and head, repository `supabase/migrations` untouched (307)**; `functions serve` with the fake-upstream env; stamped `build:web:release`; `e2e:seed`; static server. `E2E_ENABLE_MIDLIFE_MIGRATION=1`, `E2E_MIDLIFE_MIGRATION_AFTER_SEASON=5`, base/head/versions from `release-soak-migration-plan.mjs`. Engine: process-local `AGENT_BROWSER_EXECUTABLE_PATH` = Playwright `chromium_headless_shell-1243` (`--version`: Google Chrome for Testing 153.0.8010.12). `caffeinate -d -i` scoped to the run script's pid. Command: `timeout -s TERM 36000 npm run e2e:soak:release` (the package script fixes `--seasons=20` and every release flag).

| Item | Result |
| --- | --- |
| Wall | started 04:46:02Z, finished 09:38:25Z (4 h 52 min, inside the 36000 s bound; bound not hit) |
| Exit | child (npm → node) **0**; timeout wrapper passed it through (not 124); recorded separately in `run-release-exit.txt` / `run-release-exit-meaning.txt` |
| Harness report | `release-soak-report.json`: `status: PASS`, `targetSeasons: 20`, `completedSeasons: 20`, 20 season rows all PASS with the full release evidence-id set |
| Mid-life (D.LONG.5) | `season-6-midlife-migration.json`: `status: APPLIED`, command `supabase db push --local --yes`, before 304 / head `20260823000001`, after 307 / head `20260912000003`, applied exactly `20260912000001, 20260912000002, 20260912000003` at 05:59:15–05:59:16Z; `long.migration` satisfied; `run-schema-after.txt` = `307|20260912000003` |
| PWA launch gate | present every season: FCP 16–28 ms (per-season list in `pwa-launch-fcp-by-season.txt`); 400 ms budget and missing-entry failure unchanged |
| Artifacts | 20 season directories, 42 entries each, 2280 screenshots, 341 MB — kept in the session scratch dir, indexed in `artifacts-index.txt`; per-season pwa-launch summaries and the mid-life artifact are in the repo evidence |

No retries, no shortened seasons, no skipped checks. This is the first complete, passing run of the release gate on this branch.

Limits and residuals (not self-approval; independent review decides):
- The base version `20260823000001` is the newest migration on local `main`, **not** a production schema verification; CI derives the base from the linked project's `schema_migrations`.
- The engine is not recorded inside the harness's pwa-launch artifact (review-7 item 9 open); it is proven by `run-release-env.txt` and `run-conditions.txt`. The default bundled engine (Chrome for Testing 147) still emits no paint entry (phase 10); the repository does not pin the gate's engine, and CI pinning stays a candidate pending a CI run.
- Display: idle display sleep was prevented for the run's lifetime (assertion observed at 04:50Z); a physically-on display is not proven (`ioreg` gave no wrangler state). Another process's 300 s caffeinate was present at start.
- All 27 review-7 findings, round-5 1–10, round-4 10–11, round-3 10 (RLS, deferred security), 18, 20, 21, 22, 30, 33 remain open as recorded.
- Stopped only own resources: functions serve and static server pids, `supabase stop` exit 0; no global browser close; no production, publication, cleanup helper or settings changes.
