# WORKLOG — task t_a4dc0293 (hardening iteration)

Branch: `task/t_a4dc0293-hardening`. Baseline commit: `2909a0a` (main, clean tree) on 2026-09-12.
Host: MAIN MacBook, Node v26.7.0, Deno, psql 14 client, Supabase CLI. All commands ran inside the
Claude Code sandbox (filesystem write limited to repo + tmp; no local port binding; no Docker socket).

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
