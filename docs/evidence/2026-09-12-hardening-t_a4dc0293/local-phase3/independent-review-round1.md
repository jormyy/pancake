# Review — `task/t_a4dc0293-hardening` vs `main` (round 1)

**Request changes.** The new waiver-edit DB test cannot pass on any database, and CI runs it on every pull request and push to main.

Reviewed `main...40d94a3` — 67 files, +5,832/−149, 15 commits, 2 migrations.
Five dimensions, adversarially verified. **9 raised / 3 refuted / 6 survived (2 material, 4 minor).**
One survivor gates. The SQL fix it was written to prove is correct.

**The production function is right. Its test is broken, so merging turns main's DB check from green to red.**

## Gating

### 1. B1 — `waiver-claim-edit-gates.sql` fails on every fresh database · material · **gating** · [VERIFIED]

`tests/db/waiver-claim-edit-gates.sql:27-29` and `:72`

It has two independent defects:

- It never seeds `waiver_priorities`. `create_waiver_claim_atomic` refuses before any gate under test runs.
- Case 5 sets `leagues.weekly_add_limit = 0`. CHECK `leagues_weekly_add_limit_valid` allows only NULL or ≥ 1.

Reproduced on an isolated Postgres 17. All 306 migrations were applied verbatim from HEAD.

```
$ psql "$DB" --set ON_ERROR_STOP=1 -f tests/db/waiver-claim-edit-gates.sql ; echo exit=$?
psql:tests/db/waiver-claim-edit-gates.sql:29: ERROR:  No waiver priority found for your team.
exit=3
# with only a waiver_priorities row added:
ERROR:  new row for relation "leagues" violates check constraint "leagues_weekly_add_limit_valid"
# with both fixed:
NOTICE: ok: self-drop refused / ok: closed window refused / ok: ineligible league refused / ok: add limit refused
exit=0
```

The refuter repeated this independently. No seed or trigger creates the priority row: `supabase/seed.sql` does not exist, and the member and season triggers seed only FAAB balances.

- **Blast radius:** `.github/workflows/test.yml:142` runs `npm run test:db` on every pull request and push to main. `package.json:54` chains this suite last. Before this branch, main passed all 17 suites.
- **Author's own record:** `WORKLOG.md:147` says "DB test NOT executed here."
- **Fix:** after line 25, insert `waiver_priorities (league_id, league_season_id, member_id, priority = 1)`. At line 72, set `weekly_add_limit = 1` and upsert `weekly_add_counts.add_count = 1` for `private.current_add_week_number(league, season)`. This exact patch passes.

## Material

### 2. C1 — NBA CDN body read lost its 20 s timeout · material · pre-merge ask · [VERIFIED]

`supabase/functions/_shared/nba.ts:64` with `supabase/functions/_shared/retry.ts:27-31`

`attempt()` clears its timer once `fetch` resolves on headers. `cdnGet` then runs `await res.json()` with no deadline. On main, the 20 s timer wrapped the body read too.

The refuter ran a local Deno server that sends headers and then stalls:

```
main-style  : threw AbortError after 1008ms
branch-style: still pending after 5004ms (5s cap)
```

- **Blast radius:** box scores are fetched one at a time. On main, one stalled box score failed that game after 20 s. On this branch, it hangs the whole run until the platform kills the worker. No game after it gets stats that tick, and the `sync_runs` row stays `running`. The live-poll lease (90 s) caps it to one or two lost ticks.
- **Why not gating:** it errs toward stale data and heals itself.
- **Fix:** keep an overall `AbortSignal.timeout(…)` in `cdnGet` that covers `res.json()`, alongside the per-attempt timeout. Add a body-stall case to `retry.test.ts`.

## Smaller notes

### 3. S1 — duplicate roster-transactions index · minor · pre-merge ask · [VERIFIED]

`supabase/migrations/20260912000001_retention_and_history_indexes.sql:28-29`

`20260702000003_instant_app_secondary_read_indexes.sql:13-15` already covers the players-history query with `(player_id, league_id, occurred_at DESC)`. EXPLAIN on the scratch DB gives the same plan and cost (8.17) with either index, and no other reader uses the new one. The comment at `:8-10` ("only single-column indexes available") is false.

**Fix:** delete the statement while it is unshipped, and correct the comment.

### 4. S2 — the migration comment promises a CONCURRENTLY predeploy build that does not exist · minor · pre-merge ask · [VERIFIED by reading]

`supabase/migrations/20260912000001_retention_and_history_indexes.sql:12-14`

`.github/workflows/production-deploy.yml:167-179` runs only the `20260710130000` predeploy files. Production runs the plain `CREATE INDEX` statements.

Lowered from material:

- The tables are small or pruned.
- Each statement has a 5 s lock timeout.
- A failed build rolls back and stops the deploy before edge functions ship, so it fails safe.

Production row counts were not measured. The header also says the prune runs "nightly". It runs weekly (`20260815000004:87`).

**Fix:** correct the comment. Add a predeploy file only if a table is large.

### 5. S3 — the trades empty state can never render · minor · pre-merge ask · [VERIFIED by reading]

`app/(tabs)/trades.tsx:225`

`lib/trades-screen-model.ts:120,133,145,152` always adds a header row, so `listData.length === 0` is never true. Inline empty rows ("No incoming offers." and so on) already existed on main. The commit message claims a change users will never see. `tests/ux-state-contracts.test.ts:21-28` only matches source text, so it passes whether the branch is live or dead.

**Fix:** delete the branch, the `TRADE_TAB_EMPTY_TEXT` map and the source-text assertion.

### 6. S4 — the Home error card replaces the live-draft card · minor · post-merge tracker · [VERIFIED by reading]

`app/(tabs)/index.tsx:295`

The new `error ?` branch comes before `league?.status === 'drafting'` at `:311`. When the cached matchup is null and a refresh fails, "Your draft is live — Go to Draft Room" becomes "Couldn't load your matchup". The state is reachable: `hooks/use-matchup-data.ts:214-215,273,276`. The sidebar's Draft Room link still works.

The no-matchup half of this candidate was refuted: showing an error there is the intended fix, and it is the safe direction.

**Fix:** check `drafting` before `error`, or show the card only when `matchup === undefined`.

## False alarms cleared

- **Doubled worst-case fetch time (~40.7 s):** a deliberate trade. On main, the retry reused an already-aborted signal and could never recover from a hang.
- **Absolute `/Users/...` paths in evidence files:** main already has the same pattern, the repo is private with no remote, and no secret, JWT or key was found.
- **Hourly update check reloads mid-task:** documented in `docs/pwa-live-data.md:114-118`. Main already reloads mid-task on return to the foreground. Only the trade composer's unsaved state is at risk.

## Checked and solid

- **Waiver edit gates** (`20260912000002`): every gate refuses correctly once the test is seeded (executed above). Grants survive `CREATE OR REPLACE` with the same signature. The body matches the canonical `by-name` file byte for byte. `assert_weekly_add_available` counts processed adds, not pending claims, so an edit never blocks itself. Lock order (claim, then league) matches the processor.
- **Both migrations** apply cleanly on fresh Postgres 17. All four indexes exist, and `tests/db/retention-pruning.sql` passes.
- **Playoff finalization filter** (`supabase/shared-src/sync/scores.ts:208-215,532-534`): the RPC never writes points. Unfinalized rows always pass, so notifications still fire. A tie compares as unchanged. `numeric(10,2)` values compare equal to the 2-dp computed ones. An empty write list is safe. The generated copy matches.
- **`retry.ts` abort handling:** the listener is `once` and removed in `finally`. A caller abort skips the retry.
- **Stat diff:** `statDiff.ts` is a byte-for-byte move with no stale importers.
- **Edge bookkeeping:** `process-waivers` notification cannot throw mid-drain. The `sync_runs.error` column is unbounded `text`. Every column `/sync/backfill/:id` now selects exists, and nothing reads the dropped ones.
- **PWA:** `sw.js` `cacheable()` rejects opaque responses and HTML, and allows HTML only for the shell. A cold cache with a dead network rejects into the outer network fallback. `+html.tsx` has no reload loop.
- **Client:** `useFocusAsyncData` guards against non-web environments, shares in-flight loads and removes its listeners. DaySelector at 44 px still fits 320 px screens.

## Coverage caveat

These areas got lighter treatment:

- The ~3,900 lines of `docs/evidence/` were scanned only for secrets and paths.
- The e2e harness scripts (`browser-smoke.mjs`, `soak-fixtures.mjs`, `perpetual-season.mjs`, `harness-cleanup.mjs`) were read, not run.
- No UI change was exercised in a browser.
- The vitest and Deno suites were not re-run here (no `node_modules`).
- The body-stall reproduction used a standalone Deno script that mirrors `cdnGet`, not the function itself.
- Production table sizes are estimates.

Nothing in these gaps bears on the gating item.

<sub>Evidence is `file:line` at HEAD `40d94a3` vs `main`. The database findings were reproduced on an isolated Supabase Postgres 17 built from the verbatim migration files. Judge scores: grounding 5, calibration 4, scope honesty 5, actionability 5.</sub>

VERDICT: BLOCK
