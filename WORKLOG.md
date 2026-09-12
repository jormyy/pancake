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
