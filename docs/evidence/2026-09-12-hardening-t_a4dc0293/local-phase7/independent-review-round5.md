# Review — `task/t_a4dc0293-hardening` vs `main` (round 5)

**Approve.** Round 4's gating item is fixed. CI's database job now passes all 22 suites, and nothing gating survived this round.

Re-reviewed `c34c33c..1a98fc2`: 5 commits (test fix `c18c6b8`, fix wave `677a866`, evidence `766d126`, worklog `57c045b` and `1a98fc2`), 35 files, +5,590/−35. Full branch: `main...1a98fc2`, 203 files, +28,842/−314, 32 commits, 3 migrations.
There were four hunt dimensions: live-poll (the crown jewel), optimizer and trade hooks, SQL tests, and one unsteered cross-cutting sweep. Every candidate was refuted by an agent that did not raise it.

**17 raised / 7 refuted / 10 survived (0 blocker, 0 material, 4 minor, 6 nit).** None gates.

**The main open item is round 4's item 5, and it is only half fixed. A box score that never arrives still fails live-poll every minute on the evening after the games end (item 1).** It is noise and it fails safe, so it does not gate.

## Round-4 scorecard

| Item | Status | How I checked |
| --- | --- | --- |
| 1 — waiver test enum literal (gating) | **Fixed** | `tests/db/waiver-claim-projection.sql:61`. CI's database job on an isolated stack from HEAD's migrations: all 22 suites pass, and `npm run test:db` exits 0. Claim B reports `failed_roster`. |
| 2 — trade banners never clear | **Fixed** | `hooks/use-trade-block.ts:53`, `:62`, `:95`; `hooks/use-trades-feed.ts:39`, `:70`. The refresh clears are pinned by a test. The reset clears are not (item 2). |
| 3 — optimizer failures hidden from monitoring | **Fixed** | `supabase/functions/lineup-optimizer/index.ts:114-123`. `recordSyncRun` returns the inner result, so the response shape is unchanged. |
| 4 — "stats does not wake" case cannot fail | **Fixed** | The test seeds its own player (`tests/db/live-poll-gate-and-lease.sql:16-19`). **I fed it breakage:** a gate that ignores stats → exit 3 (`a Final game that has its stats woke live-poll again`). Real gate → exit 0. |
| 5 — missing box score fails every tick | **Partly fixed** | The backoff works only when missing stats is the sole reason to sync. See item 1. |
| 6 — no test for the error split | **Fixed** | `tests/hooks/trade-error-split.test.ts`. Reverting the refresh clear, or routing either failure back to `setError`, fails the test. It still has gaps (item 2). |
| 7 — no test runs live-poll's worker branch | **Partly fixed** | Only the pure decision function is tested. See item 3. |
| 8 — heartbeat comment overclaims | **Fixed** | `supabase/functions/_shared/leaseHeartbeat.ts:5-8` matches the checks at `live-poll/index.ts:94`, `:150`, `:159`. |
| 9 — raise-case counts cannot fail | **Fixed** | Both counts were removed. The message match stays (`tests/db/cron-dispatch-catchup.sql:38-46`). |
| 10 — deploy-day seed can skip one catch-up | Noted, unchanged | Tracker. It fails safe. |
| 11 — lost lease writes a failed row | Noted, unchanged | Tracker. |
| 12 — banner text runs together | **Fixed** | `app/(tabs)/trades.tsx:227`. Every reachable server message ends in "." or has no end mark. |
| 13 — two catch-up comments overclaim | **Partly fixed** | `claim_cron_dispatch` was reworded. The weekly gate comment was not, but the commit says it was. See item 4. |
| Round 3, carried | Unchanged | 10 (RLS on `cron_dispatch_state` / `edge_invocations`: the grants still revoke PUBLIC, anon and authenticated, so the risk is unchanged), 18, 20, 21, 22, 30, 33. Partly fixed: 17, 28, 29. |

## Gating

None.

## Pre-merge asks (not gating)

### 1. The backoff does not stop the per-minute failures in the common case · minor · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

`supabase/functions/live-poll/index.ts:159-163`. The fetch filter is at `supabase/functions/_shared/syncStats.ts:126` and the throw at `:69`.

```ts
query = query.or(`status.neq.Final,stats_synced_at.is.null,stats_synced_at.lt.${recheckCutoff}`)
```

**The 30-minute backoff removes a broken game from the count of reasons to sync. It does not remove the game from what the sync fetches.**

- A box score that fails never sets `stats_synced_at`, so `statsGamesForDate` picks the game on every call. The per-game catch collects the failure, and `:69` throws after the loop.
- In the evening, when today's scoreboard shows every game Final, `allDone` is true on each tick, so `decideLivePoll` returns `synced` without needing `missingFinalStats`. The gate keeps waking the poll because the game has no stats (`invoke_live_poll_if_due.sql:24-31`). Each tick refetches the game, returns 500, and reconcile writes a failed `cron:live-poll` row (`20260912000003:189`). This lasts until the scoreboard rolls over. The same per-tick failure also runs while other games are live. That part is already on `main`.
- The fix works only when no other sync reason exists: an empty scoreboard, or a status check with nothing live.
- **Provenance:** the evening loop comes from this branch, because `main`'s gate never wakes the poll for a stats-less Final game. The worse part is already on `main`: a broken game from yesterday throws before today's date is fetched (`syncStats.ts:84`, dates run yesterday first), so today's live stats and `syncScores()` stall while games are live. `main` has the same filter and the same throw (`main:syncStats.ts:68`), so that part is a pre-existing note.
- **Why not gating:** it fails safe. It writes noise and stale data, not wrong data. Commit `677a866` says the fix makes the retry happen "on a 30-minute backoff … instead of every tick". That holds only on the no-other-reason path.
- **Fix:** move the backoff into the fetch. Record a failed-attempt time in `syncStatsGameWithResolver` and exclude recently failed Final games in `statsGamesForDate`. Then drop the `updated_at` stamp. Separately, let `syncStatsForDates` finish every date and throw once at the end, so `syncScores()` still runs.
- A hunter and a separate refuter derived this independently from source. I did not run the edge function against a failing upstream.

### 2. The new hook test cannot fail on the league-switch clears · minor · pre-merge ask · [VERIFIED]

`tests/hooks/trade-error-split.test.ts:29`, `:51`; the clears are at `hooks/use-trade-block.ts:95` and `hooks/use-trades-feed.ts:70`.

The refuter ran three mutations against all of `tests/`, and each still passed 121 files and 701 tests:

- remove the reset clear at `use-trade-block.ts:95`;
- remove the reset clear at `use-trades-feed.ts:70`;
- clear the trades list when `loadMore` fails.

The second test's title says it "keeps the first page", but its first-page mock returns `trades: []` and nothing checks the list. **Fix:** mock a non-empty first page and assert it survives a failed `loadMore`. Re-render with a new `leagueId` and assert both errors are null.

### 3. Live-poll's handler wiring is still untested · minor · pre-merge ask

`supabase/functions/_shared/livePollDecision.test.ts:26`; handler at `supabase/functions/live-poll/index.ts:87`, `:90`, `:150`.

The Deno tests cover `decideLivePoll` and `gamesDueForStatsRetry` only. Nothing fails if you remove the lease check before the upsert (`:150`), either `touchGames` call (`:87`, `:90`), or the `finalGamesDueForStatsRetry` query. The stale case is `MISSING_STATS_RETRY_MS + 1000`, so changing `>=` to `>` at `livePollDecision.ts:44` still passes. This is round-4 item 7, partly fixed. A handler test with a stubbed client would also have exposed item 1.

### 4. The weekly gate comment still overclaims, and the commit says it was fixed · nit · pre-merge ask

`supabase/migrations/20260912000003_scheduling_catchup_and_durable_invocations.sql:254-255`, and the same text at `supabase/sql/functions/by-name/public/invoke_dynasty_ranking_views_at_et_time.sql:18-19`.

```sql
-- Weekly: due on Monday from the target ET time, and on any later tick that
-- week if Monday was missed; dispatched once per ISO week.
```

The only caller, `nba-sync-rankings`, runs `'0 11,12 * * 1'` (`20260817000002:320-323`). No later tick exists that week, so a missed Monday waits a week. The weekly comment lines did not change in `c34c33c..1a98fc2`. The migration's only edits in this range are the `claim_cron_dispatch` comment and one blank line. Commit `677a866` says "#13 claim_cron_dispatch and the weekly gate comments no longer overclaim". **Fix:** say that the Monday 12:00 UTC tick catches up a missed 11:00 tick, and that a missed Monday waits until the next Monday.

## Post-merge tracker

5. **A long optimizer run gets two rows that disagree** · minor · plausible. Cron invokes use a 30 s timeout (`invoke_edge_function.sql:60`). If a run takes longer, reconcile writes a failed `cron:lineup-optimizer` row, and the run writes success (`lineup-optimizer/index.ts:114`). If the platform kills the run, the row stays `running`, and nothing sweeps such rows. The same pattern exists at ten other `recordSyncRun` call sites in eight functions. This round only added the optimizer. **Fix direction:** a sweep that marks `sync_runs` rows still `running` past the platform limit as failed.
6. **The stamp can hit a game that was never fetched** · nit. `live-poll/index.ts:87` stamps every due game on any throw, including a failure on another date. The real gap then waits 30 minutes.
7. **The gate still wakes the poll every minute while nothing is due** · nit. `invoke_live_poll_if_due.sql:24-31` does not know about the backoff. Each wake costs a lease, a scoreboard fetch and a few queries, and writes no failed row. This is cheaper than at `c34c33c`, where each wake ran a full sync.
8. **A failed stamp is only logged** · nit. `live-poll/index.ts:205`. The retry then falls back to every tick, which is `c34c33c`'s behaviour.
9. **The null `updated_at` branch is dead** · nit. `livePollDecision.ts:43-44`. The column is `NOT NULL` (`20260226000001_initial_schema.sql:280`).
10. **A realtime refresh can clear a failed-add banner** · nit · plausible. `use-trade-block.ts:62` clears `actionError` on every `refresh`, and the realtime block refresh calls it while the user is on a block tab. On `main`, the same failure went through `setError`, which refresh also cleared, so this is no worse than `main`.

- **Pre-existing note (on `main`):** one broken box score from yesterday stalls today's live stats and scores while games are live (item 1, second part).
- Carried: round-4 items 10 and 11. Round-3 items 10, 18, 20, 21, 22, 30 and 33.

**Top asks: items 1 and 2, then 3 and 4. Everything else is minor or nit. Nothing gates.**

## False alarms cleared

- **Editing the unshipped migration is fine.** `20260912000003` is not on `main`, the branch already edited it in `b59c3e2`, and no deploy of this branch is recorded. Only a database built from the older file sees a catalog mismatch, and `db reset` clears it.
- **The banner regex adds no double punctuation in practice.** "?." and "…." are possible, but no reachable message ends that way. The messages come from `add_trade_block_item_atomic.sql`, `remove_trade_block_item_atomic.sql` and `supabase/functions/api/trades.ts:431`.
- **A thrown optimizer run with two failure rows is by design.** Every `serveInternal` plus `recordSyncRun` caller writes one row for the run and one for the HTTP call.
- **The optimizer's new row per run is not noise.** `invoke_lineup_optimizer_if_due` gates it to game weeks, live-poll already writes about 900 rows a day, and `sync_runs` is pruned at 90 days.
- Also refuted: the `cron-dispatch-catchup` comment about statement atomicity (correct for production), the cleanup list missing `cron-raise-fn` (that row cannot outlive its savepoint), and the `??` fallback that never applies (dead code from `main`, and the server never returns an empty message).

## Checked and solid

- **CI's database job, step by step,** on an isolated Supabase stack (its own project name and ports) built from HEAD's verbatim migrations:
  - `check:database-types` exit 0;
  - the edge health check returns 200;
  - `check:db-function-catalog` exit 0;
  - 307 migrations applied, and the migration-head diff is empty;
  - `npm run test:db` runs all 22 suites and exits 0. It leaves 0 players behind.
- **Unit, type and edge checks:**
  - vitest: 701 of 701 tests pass across 121 files;
  - `typecheck` and `typecheck:tests` exit 0;
  - `check:db-function-sources` exit 0;
  - `node scripts/check-edge-functions.mjs` with CI's Deno 2.7.14: `ok | 121 passed | 0 failed`.
- **The new hook test has teeth where it claims them.** Four reverts each fail it: the two refresh clears, and routing either failure back to `setError`. Its mocks match the real exports.
- **The decision refactor keeps behaviour.** `decideLivePoll` (`livePollDecision.ts:19-29`) matches `c34c33c`'s inline branches for every input. The only changes are the intended ones: the narrower missing count, and the early lease check at `live-poll/index.ts:150`.
- **Stamping `updated_at` has no side effects.** Nothing in the app reads `nba_games.updated_at`, and the table is not in the realtime publication.
- **A league switch cannot leak a stale error.** `mutationGeneration` (`use-trade-block.ts:88`) gates the late add, and `loadSequence` gates the late page.
- **The players fixture is valid.** It supplies every required column, collides with nothing, and rolls back with the file.
- **Authorization:** every new or changed SQL function is `SECURITY DEFINER` with a pinned `search_path`. New signatures grant EXECUTE to `service_role` only (`20260912000003:364-379`). Replaced functions keep `main`'s grants.
- **Migrations, CI and secrets:**
  - three migration files are added and none on `main` is edited;
  - the only drops are `DROP FUNCTION IF EXISTS` on signatures recreated in the same file;
  - `git diff main...1a98fc2 -- .github` is empty, and no `.skip` or `.only` was added;
  - added lines contain only placeholder tokens.

## Coverage caveat

- There is no remote and no CI run. I ran CI's own database commands locally, with the local Supabase CLI 2.114.0, not CI's 2.109.1, and with Node 20, not CI's 22.
- Items 1, 3, 4 and 5–10 are reasoned from source, not executed. Item 1 was derived twice, by separate agents. I did not run the live-poll edge function against a failing upstream. No UI change was exercised in a browser.
- The e2e harness (seed, perpetual, soak, browser chain) was not run this round. The WORKLOG still lists the 20-season `e2e:soak:release` as an unfinished release gate. That is the author's own gate, not a finding.
- The ~5,500 new lines under `docs/evidence/` were scanned only for secrets.
- **Refutation method:** each material candidate got its own refuter. Minor and nit candidates were refuted in batches, one batch per dimension, each in a context that did not raise them. I raised item 4 myself, and an agent that never saw my reasoning refuted it.
- **Ledger severities:** the ledger tool has no nit level, so it records all 10 survivors as minor. The minor/nit split above is the refuters' corrected severity.
- **`lessonsctl.py propose` did not run.** `lessonsctl.py propose --log <ledger>` returned `command not found` (exit 127). No `lessonsctl` script exists under the home directory, `~/.claude`, or the skills sources, and no lessons inbox exists under `~/.cache`. The 10 survivors and 7 refutations stay in the ledger until the tool exists.
- This is an independent judge pass, not a self-review.

None of these gaps bears on a gating question. The one gating item from round 4 was reproduced fixed on a real database.

<sub>Evidence is `file:line` at HEAD `1a98fc2` vs `main`. DB results come from an isolated Supabase stack (project `pancake-r5review`), built from the verbatim migration files and stopped afterwards. Ledger: 17 candidates, 7 refuted, 10 survived, every one terminal. An independent judge spot-checked about 30 citations and scored grounding 4, calibration 5, scope honesty 5, actionability 4. Its corrections are applied, except that the `lessonsctl` result stays because it was requested.</sub>

VERDICT: APPROVE
