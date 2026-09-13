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
