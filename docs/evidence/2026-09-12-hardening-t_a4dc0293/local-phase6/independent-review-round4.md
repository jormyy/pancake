# Review — `task/t_a4dc0293-hardening` vs `main` (round 4)

**Request changes.** The fix wave repairs three of round 3's four gating items. The fourth, the waiver test, still fails CI's database job on one wrong enum value.

Re-reviewed `09676e4..c34c33c` — 2 commits (fix commit `b59c3e2`, worklog `c34c33c`), 46 files, +4,007/−78. Full branch: `main...c34c33c` — 180 files, +23,283/−310, 27 commits, 3 migrations.
Four hunt dimensions (scheduling SQL and DB tests, edge runtime, client and PWA, one unsteered cross-cutting sweep). An agent that did not raise a candidate tried to refute it. 24 raised / 11 refuted / 13 survived (0 blocker, 1 material, 9 minor, 3 nit). One survivor gates.

`test:db` still stops red. With a one-word fix to the test, all 22 suites pass and CI's chain exits 0. I ran both.

## Round-3 scorecard

| Item | Status | How I checked |
| --- | --- | --- |
| 1 — generated types stale (gating) | **Fixed** | `npm run check:database-types` exit 0 on a fresh stack with CLI 2.114.0, and again with CI's pinned 2.109.1. |
| 2 — dropped signatures (gating) | **Fixed** | `dynasty-decision-inputs` and `season-boundary-gate` pass. `db-security-catalog.mjs:112-114` and `rls-grants.test.ts:84-87` name the `timestamptz` forms. Before migration, the production readiness check now fails as one whole query instead of row by row. It already failed before migration on main for any release that adds a migration (`db-security-catalog.mjs:242-246`), so this is not new. |
| 3 — psql variables in `DO $$` (gating) | **Fixed** | Both suites pass. Reconcile reports 4 rows. |
| 4 — waiver fixture (gating) | **Partly fixed** | Line 28 now passes. The suite now fails further down, at `:60` (item 1 below). |
| 5 — one failing member blocks auto-set | **Fixed** | Per-member try/catch at `lineup-optimizer/index.ts:211-225`. The fix hides failures from monitoring (item 3). |
| 6 — missing-stats wake does not fetch | **Fixed** | `live-poll/index.ts:77-85`, `:143`. A bad box score now costs a failed row per tick (item 5). |
| 7 — catch-up wording | **Partly fixed** | Header `20260912000003:3-10` and `docs/source-monitoring.md:30-35` are now accurate. Two function comments still overclaim (item 13). |
| 8 — deploy-day double dispatch | **Fixed** | The seed at `20260912000003:379-406` claimed all five periods when the migration ran on my stack (Saturday, after every target). Correct in EST and EDT against the live `cron.job` schedules. |
| 9 — rollback wording too broad | **Fixed** | `20260912000003:8-10`. |
| 10 — new tables lack RLS | **Not fixed, deferred** | WORKLOG iteration 9 defers it. Carried below. |
| 11 — grants test names dropped signature | **Fixed** | `tests/rls-grants.test.ts:84-87`. |
| 12 — live-poll test deletes real games | **Fixed** | The `DELETE` is gone. It now skips on a database with real games. |
| 13 — catalog hand-edited | **Fixed** | `check:db-function-catalog` exit 0. All keys in `localeCompare` order. |
| 14 — reconcile vs header | **Fixed** | `NOT BETWEEN 200 AND 299` at `20260912000003:188` and the by-name copy. |
| 15 — two Home retries | **Fixed** | `app/(tabs)/index.tsx:214`. |
| 16 — trades-model test one-sided | **Fixed** | `tests/lib/trades-screen-model.test.ts:80-83`. |
| 17 — dead test branch | **Partly fixed** | `tests/service-worker.test.ts:218`: both branches still return 200 `text/html`. Nit. |
| 18 — long runs may log false failures | Unchanged | Tracker. |
| 19 — nothing acts on a lost lease | **Partly fixed** | Checked before both sync phases. The comment claims more (item 8). |
| 20 — update check reloads mid-task | Unchanged | Tracker. |
| 21 — some failures get two rows | Unchanged | Tracker. |
| 22 — health check ignores `cron:*` rows | Unchanged | Tracker. |
| 23 — scheduling test gaps | **Partly fixed** | The EDT case is real. The stats case cannot fail in CI (item 4). The raise case cannot fail on its counts (item 9). |
| 24 — S9 regex gaps | **Fixed** | `tests/e2e-harness-fixtures.test.ts:143-158` handles bare `REFERENCES players`, next-line `ON DELETE`, and `RESTRICT`/`NO ACTION`. |
| 25 — edit errors read as load errors | **Fixed, with a new defect** | The split landed. The new banners never clear (item 2). |
| 26 — retry listener stays attached | **Fixed** | `retry.ts:57` unlinks a discarded attempt. |
| 27 — renewal after release | **Fixed** | `leaseHeartbeat.ts:24`, `:28`, with a test. |
| 28 — finalization test checks only the helper | **Partly fixed** | `tests/edge-scheduling-contracts.test.ts:34-40` pins the call site with a regex over source. It fails on revert, not on behaviour. |
| 29 — boundary failure can be lost | **Fixed as log only** | `syncRuns.ts:65-68` logs it. It still never reaches `sync_runs`. |
| 30 — source-text tests | Unchanged | One more added (row 28). |
| 31 — install can leave no offline shell | **Fixed** | `public/sw.js:65`. The new test fails if the check is removed. |
| 32 — heartbeat test timing | **Fixed** | 120 ms sleeps against a 5 ms interval. |
| 33 — edit/create lock order | Unchanged | Pre-existing note. |

## Gating

### 1. The waiver-projection test asserts a status the enum does not have · material · **gating** · [VERIFIED]

`tests/db/waiver-claim-projection.sql:60`

```sql
IF NOT EXISTS (SELECT 1 FROM projection_results WHERE player_id = '…071403' AND status = 'failed' AND failure_reason LIKE 'Drop player is no longer%') THEN
```

**`waiver_claim_status` is `{pending,succeeded,failed_priority,failed_roster,cancelled}`, so `'failed'` is not a valid value and the cast raises.**

```
psql:tests/db/waiver-claim-projection.sql:68: NOTICE:  claim …071403 -> failed_roster (Drop player is no longer on this active roster.)
psql:tests/db/waiver-claim-projection.sql:68: ERROR:  invalid input value for enum waiver_claim_status: "failed"
```

- **Production is correct:** claim B comes back `failed_roster` with the expected reason. Only the test is wrong.
- **Why it gates:** it is the last suite in the `test:db` `&&` chain (`package.json:58`). The chain exits 3, so the database job fails on every PR into main and every push to main (`.github/workflows/test.yml:3-7`, `:142`). This is the same bar round 3 used.
- **Reproduced twice** on an isolated Supabase stack built from HEAD's verbatim migrations: once in CI's chain order (21 of 22 suites pass, chain exit 3), once alone after a fresh `supabase db reset`.
- **Provenance:** the line has been there since `c29e81c` (`09676e4:58`). Round 3's fixture failure at `:28` hid it. The WORKLOG says the DB suites were not re-run after `b59c3e2`. Round 3 should have caught this: it gave the fixture fix without running the file past its first error.
- **Fix:** `status = 'failed_roster'`. With only that change, all 22 suites pass and `npm run test:db` exits 0 on a fresh stack.

## Pre-merge asks (not gating)

### 2. The new trade error banners never clear · minor · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

`hooks/use-trade-block.ts:45-79` (refresh), `:81-94` (reset effect); `hooks/use-trades-feed.ts:32-60`, `:62-71`; banner at `app/(tabs)/trades.tsx:227-228`.

The round-3 split moved add/remove and load-more failures into `actionError` and `loadMoreError`. `refresh()` clears only `error` (`use-trade-block.ts:58`, `use-trades-feed.ts:45`). The identity-reset effects clear only `error` too. The banner says "Tap to refresh." and calls `refresh`, so the banner stays over a correct list.

- A league switch sets the owner key to the new league, so league A's action error shows in league B.
- If the refresh leaves `hasMore` false, `loadMore` returns early (`use-trades-feed.ts:79`) and the load-more banner stays until the screen remounts.
- **Why not gating:** it fails safe. It shows a stale message and loses no data. On main, `refresh()` did clear the same failure, so the branch introduced this.
- **Fix:** call `setActionError(null)` / `setLoadMoreError(null)` in each `refresh` and each reset effect. Add a hook test (item 6).

### 3. Lineup-optimizer failures no longer reach monitoring · minor · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

`supabase/functions/lineup-optimizer/index.ts:222-225`, handler at `:110-111`

```ts
const result = await processEnabledLineupOptimizers(requestedDate)
return Response.json({ ok: true, ...result })
```

The new catch counts `failed` and logs. The handler still returns 200. This function never calls `recordSyncRun`, and reconcile records a failure only for a non-2xx status (`20260912000003:188`). If every member throws on every run, `sync_runs` stays clean.

- **Why not gating:** it is no worse than main, where the invoke was fire-and-forget and a 500 went nowhere. It is a regression against `09676e4`.
- **Fix:** wrap the cron path in `recordSyncRun('lineup-optimizer', …)` and pass `failure` when `failed > 0`. Or return 500 when every attempted member failed.

### 4. The "Final game with stats does not wake" case cannot fail in CI · minor · pre-merge ask · [VERIFIED]

`tests/db/live-poll-gate-and-lease.sql:16-17`, `:29`

The stats row comes from `SELECT id … FROM public.players LIMIT 1`, and the assertion runs only when `players` is not empty. CI's stack has no players: `supabase/seed.sql` does not exist, and every earlier suite rolls back or deletes its players. I counted 0 players after a fresh reset and again after the full chain.

**I fed it breakage.** I replaced `invoke_live_poll_if_due` with a gate that ignores stats. The suite still exited 0. Then I restored the gate.

```
live-poll suite vs broken gate:   exit=0
live-poll suite vs restored gate: exit=0
```

**Fix:** insert a fixture player inside the test transaction, and drop the `players > 0` guard.

### 5. A missing box score now fails live-poll every tick for two days · minor · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

`supabase/functions/live-poll/index.ts:80-84`, `:143-147`; throw at `supabase/functions/_shared/syncStats.ts:68-69`

The item-6 fix syncs whenever a Final game has no stats. If the upstream box score never arrives, `fetchBoxScore` throws, no `player_game_stats` row is written, and the game stays "missing" for both the SQL gate and `countFinalGamesMissingStats`. Each tick of the `* 15-23,0-5` cron then returns 500 and writes a failed `cron:live-poll` row. That is roughly 900–1,800 rows per bad game until the game leaves the two-day window. At `09676e4` the same tick returned `idle`.

- **Why not gating:** it is bounded and it is noise, not bad data. The failure it reports is real.
- **Fix:** stamp an attempt time per game and back off (for example, retry a missing box score at most every 30 minutes).

### 6. No test covers the load-error vs action-error split · minor · pre-merge ask

`hooks/use-trade-block.ts:141`, `hooks/use-trades-feed.ts:106`. The only test reference to the new fields is a stub at `tests/app/dynasty-tools-ui.test.ts:101`. Reverting either `setActionError` or `setLoadMoreError` to `setError` fails no test. One failing-path test per hook would also have caught item 2.

### 7. No test runs live-poll's new worker branch · minor · pre-merge ask

`supabase/functions/live-poll/index.ts:77`, `:80-85`, `:143-147`. `tests/db/live-poll-gate-and-lease.sql` covers the SQL gate and the lease. `tests/edge-scheduling-contracts.test.ts:8-12` matches source text. Nothing executes the `missingFinalStats` path or the two `lease-lost` returns. **Fix:** add a Deno test that stubs `countFinalGamesMissingStats` above 0 with an empty CDN, and one that sets `heartbeat.lost` before each sync phase.

### 8. The heartbeat comment says more than live-poll does · minor · pre-merge ask

`supabase/functions/_shared/leaseHeartbeat.ts:5-6` says live-poll "checks it before each write phase". It checks at `live-poll/index.ts:82` and `:146` only. It does not check before the `nba_games` upsert (`:134-139`) or during the sync. The stat upserts are idempotent, so the damage is limited. Reword the comment, or check before the upsert too.

### 9. The rollback-on-raise case cannot fail on its counts · minor · pre-merge ask

`tests/db/cron-dispatch-catchup.sql:36-49`, asserted at `:103-104`. The DO block's exception handler and `ROLLBACK TO SAVEPOINT before_raise` both undo the claim. So `claim after raise = 0` and `dispatch after raise = 1` hold whether or not the claim rides the caller's transaction. Only the message match at `:43` can fail. Keep the message check and drop the two counts, or run the invoke in a transaction that really aborts.

## Minor — post-merge tracker

10. **The deploy-day seed can skip one catch-up.** `20260912000003:382-405` claims today for every job whose target has passed, without knowing whether the old gate ran. If it missed that day, the job runs a day late, once. It fails safe; the seed trades this for no double dispatch. Minor.
11. **A lost lease writes a failed row.** Live-poll's 409 (`live-poll/index.ts:82`, `:146`) becomes a failed `cron:live-poll` row through reconcile (`20260912000003:188`). The failure is real, but noisy. Nit.
12. **Banner text can run together.** `app/(tabs)/trades.tsx:227` appends " Tap to refresh." to a raw server message, which may have no final period. Nit.
13. **Two catch-up comments still overclaim.** `claim_cron_dispatch` says a delayed tick is "caught up by the next one" (`20260912000003:68-71` and the by-name copy). The weekly gate says "any later tick that week" (`:252-253`), but that job ticks only on Mondays (`'0 11,12 * * 1'`). Nit.
- Carried from round 3, unchanged: 10 (RLS on the two new tables), 18, 20, 21, 22, 30, 33. Partly fixed: 17, 28, 29 (see scorecard).

**Top ask: item 1 gates, and it is a one-word change. Items 2–9 should land before merge; 2–5 matter most. Everything else is minor.**

## False alarms cleared

- **Editing a claim does not burn a weekly add.** `assert_weekly_add_available` inserts `add_count = 0 … ON CONFLICT DO NOTHING` and reads under a lock (`20260701000003:429-457`). Only `consume_weekly_add` increments (`:487-493`). Create already calls the same check.
- **The lineup "touch after first failure" bug has no effect.** `lineup-optimizer/index.ts:226` uses the run-wide `failed` counter, but `last_optimized_at` only sets processing order, and the affected member has nothing to optimize.
- Also refuted: the PostgREST 1,000-row cap in `countFinalGamesMissingStats` (needs about 29 Final games on the CDN-empty branch; the extra sync is cheap), a single renewal error marking the lease lost (pre-existing at `09676e4`), league/season loads outside the per-member try (a database-wide error fails the run anyway), the Analyzer showing the offers error (pre-existing on main), the shell check accepting any HTML at `/` (correct), and the commit's "+67/−7" types count (correct for that commit).
- **The production readiness check is not a new deploy blocker.** The pre-migration run already fails on main for any release with a pending migration: the "Latest migration applied" row is BLOCKED (`tests/e2e/db-security-catalog.mjs:242-246`), and `migrate-production` needs that job. The branch only hides the other rows behind one failed query. The post-migration run is correct. That pipeline gap is older than this branch.
- Also refuted: the deploy-day seed drifting from the schedules (all five targets match; the seed runs once), and the catch-up test counting real cron dispatches (it counts test-only names; CI has no live ticks).

## Checked and solid

- **CI's database job, suite by suite,** on an isolated stack from HEAD's verbatim migrations: 307 migrations applied, the migration-head diff is empty, `check:database-types` and `check:db-function-catalog` exit 0, and 21 of 22 suites pass. The failure is item 1.
- **Once per period holds.** `cron-dispatch-catchup.sql` passes with the new EDT counts (`edt on time -> 3`, `edt second tick no double -> 3`). It executed all 5 scheduled ET-time cron commands against the current signatures.
- **Round-3's CI blocker is gone.** CI's command `node scripts/check-edge-functions.mjs` with CI's Deno 2.7.14: `ok | 117 passed | 0 failed`.
- **Unit and type checks:** vitest 699/699 (120 files), `typecheck` and `typecheck:tests` exit 0.
- **Authorization:** all new or changed SQL functions are `SECURITY DEFINER` with a pinned `search_path`. The public ones grant EXECUTE to `service_role` only (`20260912000003:360-377`). The new tables revoke PUBLIC, anon and authenticated (`:27-29`, `:46-48`).
- **Migrations:** `git diff --name-status main...c34c33c -- supabase/migrations` shows three added files and no edited ones. The index migration sets `lock_timeout 5s` (`20260912000001:21-22`).
- **Canonical sources:** all eight by-name function files match the migration bodies.
- **CI config and tests:** `git diff main...c34c33c -- .github` is empty. No `.skip` or `.only` was added.
- **Secrets:** only placeholder tokens in added lines. The evidence files contain local home-directory paths, which expose a username only.
- **Client:** Home always shows exactly one retry (`app/(tabs)/index.tsx:214`, `:310-321`). The service worker never caches HTML as an asset (`public/sw.js:38-42`), and a failed shell precache now aborts the install (`:65`).

## Coverage caveat

- There is no remote and no CI run. I ran CI's own commands locally: its Deno pin, and both the local and the pinned Supabase CLI for the types check.
- Items 2, 3, 5, 6, 7, 8, 9 and 10–13 are reasoned from source, not executed. No UI change was exercised in a browser. The e2e harness (seed, perpetual, soak, browser chain) was not run this round.
- The ~4,000 new lines under `docs/evidence/` were scanned only for secrets.
- The pre-migration production readiness run was reasoned from the workflow files, not executed against a database at the pre-migration state.
- `lessonsctl.py propose` result: not run. `lessonsctl.py propose --log <ledger>` returned `command not found` (exit 127). No `lessonsctl` script exists anywhere under the home directory, `~/.claude`, or the skills sources, and no lessons inbox exists under `~/.cache`. The 13 survivors and 11 refutations are in the ledger for whenever the tool exists.
- This is an independent judge pass, not a self-review.

None of these gaps bears on item 1, which I reproduced twice.

<sub>Evidence is `file:line` at HEAD `c34c33c` vs `main`. DB results come from an isolated Supabase stack (project `pancake-r4review`) built from the verbatim migration files. Ledger: 24 candidates, 11 refuted, 13 survived, every one terminal. Judge (an independent agent, 42 citations spot-checked): grounding 4, calibration 4, scope honesty 4, actionability 4. Its corrections are applied, except that the `lessonsctl` result stays because it was requested.</sub>

VERDICT: BLOCK
