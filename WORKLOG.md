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
