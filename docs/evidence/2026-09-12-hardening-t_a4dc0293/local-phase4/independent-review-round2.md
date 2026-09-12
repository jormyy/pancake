# Review — `task/t_a4dc0293-hardening` vs `main` (round 2)

**Request changes.** Round 1's gating item is fixed. The fix for C1 adds a Deno test that fails CI's edge job, and main passes that job today.

Re-reviewed `40d94a3..8a3874f` — 4 commits (fix commit `01d8731`), 53 files, +6,355/−141. Full branch: `main...8a3874f` — 108 files, +12,142/−245, 19 commits, 2 migrations.
Four dimensions, adversarially verified, plus one unsteered pass over the full branch. **13 raised / 5 refuted / 8 survived (1 material, 7 minor).**
One survivor gates.

**Every round-1 item is fixed in the code. A new test leaks a timer, so merging turns main's edge check from green to red.**

## Round-1 scorecard

| Item | Status | How I checked |
| --- | --- | --- |
| B1 — waiver-edit DB test fails on a fresh DB (gating) | **Fixed** | Scratch Supabase stack from HEAD's migrations: `waiver-claim-edit-gates.sql` exit 0. All 12 psql DB suites exit 0. |
| C1 — CDN body read had no deadline | **Fixed in production code** | A local Deno server sent headers and then stalled. The HEAD helper threw `TimeoutError` at 306 ms (300 ms deadline). The old helper hung until killed. The new test for it breaks CI (item 1). |
| S1 — duplicate `roster_transactions` index | **Fixed** | The scratch catalog has only `idx_roster_transactions_player_league_recent`. |
| S2 — false predeploy / "nightly" comment | **Fixed**, with a new error | The comment now names an index that does not exist (item 3). |
| S3 — dead trades empty branch | **Fixed** | The branch, the map, and the source-text test are gone. |
| S4 — Home error card hid the live-draft card | **Fixed, better than asked** | `resolveHomeSurface` puts the draft card ahead of error and ahead of the blank loading panel. |

**My round-1 misses:**

- Round 1 credited the edit gates as "executed" based on the test's `ok` notices. Those notices cannot fail for cases 3–5 (item 2). The gates are correct, and I have now proven it by printing `SQLERRM`. But the round-1 evidence could not tell a working gate from a missing one.
- Round 1 also called the focus hook solid and missed item 5.

## Gating

### 1. B2 — the new retry test leaks a timer and fails CI's edge job · material · **gating** · [VERIFIED]

`supabase/functions/_shared/retry.test.ts:83`

```ts
new Promise((_, reject) => setTimeout(() => reject(new Error('body read did not abort')), 500)),
```

The body read loses the race at about 30 ms. The 500 ms timer is never cleared, so Deno's default op sanitizer fails the test.

I ran `node scripts/check-edge-functions.mjs` (the CI command) with Deno 2.7.14, the version CI pins at `.github/workflows/test.yml:57-59`:

```
main: ok | 100 passed | 0 failed        exit 0
HEAD: a caller deadline aborts a body that stalls after headers ... FAILED
      error: Leaks detected:
        - A timer was started in this test, but never completed.
      FAILED | 112 passed | 1 failed    exit 1
```

A fresh refuter reproduced this. Nothing disables the sanitizer: there is no `deno.json`, and the script passes only permission flags.

- **Blast radius:** `test.yml:61` runs the check on every PR to main and every push to main. After merge, every later PR's edge job is red. `npm run check:comprehensive` fails too.
- **Author's own record:** `WORKLOG.md` says the test is "5/5" and Deno is "PASS 112/0". Neither holds at HEAD.
- **Provenance:** introduced by `01d8731`. The test file does not exist on main.
- **Fix:** keep the timer id and clear it once the race settles. With this patch the file passes 5/5:

```ts
let guard: number | undefined
await Promise.race([
  res.text(),
  new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('body read did not abort')), 500) }),
]).catch((error) => { thrown = error }).finally(() => clearTimeout(guard))
```

The test does catch the old bug. Against the `40d94a3` helper it fails with "body read did not abort". Only its cleanup is wrong.

## Smaller notes

### 2. S5 — waiver-edit test cases 3–5 cannot fail · minor · pre-merge ask · [VERIFIED]

`tests/db/waiver-claim-edit-gates.sql:57`, `:69`, `:82`

Each case raises `RAISE EXCEPTION 'expected … refused'`, which has SQLSTATE P0001. Each handler catches `WHEN SQLSTATE 'P0001'`. If the gate is missing, the block catches its own failure and prints `ok`. The handler also rolls back the edit, so the final-state check at `:86-94` passes too.

I installed main's ungated `edit_waiver_claim_atomic` inside the transaction and ran cases 3–5:

```
NOTICE:  ok: closed window refused -- SQLERRM=expected closed-window edit to be refused
NOTICE:  ok: ineligible league refused -- SQLERRM=expected ineligible league edit to be refused
NOTICE:  ok: add limit refused -- SQLERRM=expected exhausted add limit edit to be refused
exit=0
```

At HEAD the real gates refuse with the right messages ("This player is no longer on waivers.", "Waiver claims require an active or playoff season.", "Weekly add limit reached (1/1 adds used this week)."). Case 2 (22023) is sound; it fails against main's function.

- **Why not gating:** the production gates are correct, and I verified them by execution. This is a missing regression guard, not a live defect.
- **Fix:** in each handler, re-raise unless `SQLERRM` matches the expected message, for example `IF SQLERRM NOT LIKE 'Weekly add limit reached%' THEN RAISE; END IF;`. Then run the test once against main's function to show it goes red.

### 3. S6 — the index migration comment names an index that does not exist · minor · pre-merge ask · [VERIFIED]

`supabase/migrations/20260912000001_retention_and_history_indexes.sql:11` and `:7-8`

The comment names `idx_roster_transactions_player_league_occurred`. The real index is `idx_roster_transactions_player_league_recent` (`20260702000003:13`). Lines 7–8 say standings "only had a member_id index". `idx_standings_league_season_id`, `idx_standings_league_season_week` and a unique key also exist. The new index is still justified, because none of those leads with `(league_season_id, member_id)`.

**Fix:** correct both sentences while the migration is unshipped.

### 4. S7 — the `home-surface.ts` comment contradicts its code · minor (nit) · pre-merge ask · [VERIFIED by reading]

`lib/home-surface.ts:2-4`

The comment says "a live draft always wins… then a real matchup". The code at `:13` returns `'matchup'` before `:14` checks `drafting`. The code is right: main also checks the matchup first, and the test pins it. The draft card wins only over loading and error.

**Fix:** reword it to "matchup, then live draft, then loading, then error, then empty".

### 5. S8 — reconnect and foreground refetches run on every hidden tab · minor · post-merge tracker · [VERIFIED by reading]

`hooks/use-focus-async-data.ts:125-135`

The `online` and `visibilitychange` listeners call `load()` without a focus check. On web, `NativeTabs` mounts every tab screen at startup (Radix `forceMount`; inactive tabs are hidden with CSS only). Five hook instances run across roster, players, trades and dynasty.

- **Effect:** one reconnect sends about 11 read requests. On main it sent none until a tab gained focus.
- **Side effect:** if a hidden fetch fails less than 5 minutes after a good load, focusing that tab shows a "Failed to load… Tap to retry" banner over valid data.
- **Why not gating:** it only reads. The one call with SQL side effects (`get_member_transaction_state`) is idempotent. It fails toward extra load.
- **Provenance:** introduced by `1a27a2c`, inside round 1's range.
- **Fix:** set an `isFocusedRef` in `useFocusEffect` and check it in both listeners.

### 6. S9 — the cleanup-list test cannot catch a new missing table · minor · post-merge tracker · [VERIFIED by reading]

`tests/e2e-harness-fixtures.test.ts:113`

The test checks only that listed tables still exist. The list is complete today: all 11 no-action foreign keys to `players` are on it. A future table with a plain foreign key to `players` would not turn it red.

**Fix:** derive the expected set from `pg_constraint` in the DB suite, or assert it against the migration scan.

### 7. S10 — draft-order body reads have no deadline · minor · post-merge tracker · pre-existing · [VERIFIED by reading]

`supabase/functions/sync-draft-order/lib.ts:211` (body reads at `:154`, `:194`)

This is the same class as C1, but main had it too. Main's 20 s timer was cleared once headers arrived. The branch improved only the header phase. It fails safe: every fetch finishes before any write. The job runs only in June and July.

**Fix:** pass `signal: AbortSignal.timeout(45_000)`, as `cdnGet` does. A shared `totalTimeoutMs` option in `fetchWithRetry` would be better.

### 8. S11 — a failed trades load shows empty rows under the error banner · minor · post-merge tracker · pre-existing · [VERIFIED by reading]

`lib/trades-screen-model.ts:122-155`

`buildTradeList` checks only the loading flags. With an empty cache and a failed fetch, "No incoming offers." shows under "Failed to load trades. Tap to retry." (`app/(tabs)/trades.tsx:216`). `trades.tsx` is byte-identical to main. The Picks tab already hides its list on error (`trades.tsx:223`), so the pattern exists.

**Fix:** pass a `hasError` input to `buildTradeList` and skip the empty rows when it is set.

## False alarms cleared

- **"full" substring opens the drop picker for another error:** `add_free_agent_atomic` raises "full" only for the roster-full message (`add_free_agent_atomic.sql:137`). The match is unchanged from main.
- **Seed pre-delete wipes the dynasty RPC test's rows:** this happens only if both run by hand at the same time. No script or workflow does that.
- **A real rankings sync breaks the soak dynasty check:** the sync does delete the synthetic rows, but real rows then satisfy the check.
- **Synthetic rankings mask a short sync in source health:** `e2e:seed` runs only against fresh local stacks (`test.yml`, `release-soak.yml`). Source health is a manual script.
- **Username paths in evidence files:** round 1 already cleared this class. No JWT, key or password is in the new evidence.

The unsteered pass also reported the draft-order deadline. I merged it into item 7, so it is not counted twice.

## Checked and solid

- **Edit gates** (`20260912000002:71-99`): each gate refuses with its own message at HEAD (executed). The canonical `by-name` file matches the migration byte for byte. The lock order matches main.
- **C1 fix** (`nba.ts:61-73`, `retry.ts:28-38`): a 20 s per-attempt budget plus a 45 s total fit together (worst case about 40.7 s before the body). A caller abort is never retried (`retry.ts:61`). The attempt listener stays linked only on success, and `cdnGet` makes a new signal per call, so listeners cannot pile up.
- **Round-1 fixes in the client:** `useQuickAdd` has two callers, and both match the new signature. The removed waiver path was unreachable (`players.tsx:266-272` sends waivered players to the claim modal). `editWaiverClaim`'s only caller passes `claim.dropPlayerId`. None of the 14 unexported types is imported anywhere.
- **Harness:** the cleanup list now omits `trade_drop_reservations`. The new scan test would have gone red on the old list. The dynasty fixtures match the `(source, source_rank)` unique index and the scoring-format CHECK.
- **Suites run on scratch copies of HEAD:** vitest 119 files / 691 tests pass. `tsc --noEmit` passes. All 12 psql DB suites pass on a scratch Supabase stack from the verbatim migrations.
- **Unchanged since round 1 and re-checked in the unsteered pass:** the finalization filter, boundary failure recording, per-batch waiver notifications, `sw.js` caching rules, and the `+html.tsx` update check.

## Coverage caveat

These areas got lighter treatment:

- The six Node-based `test:db` suites (waiver backlog, multi-team trade and the others) were not run. My scratch stack left out the edge runtime. So I cannot claim the full `npm run test:db` chain is green.
- No UI change was exercised in a browser. Items 5 and 8 are reasoned from source and the expo-router web build.
- The e2e harness (seed, perpetual, soak, browser smoke) was read, not run.
- The ~2,900 new lines under `docs/evidence/` were scanned only for secrets.
- There is no remote and no CI run. The CI claims come from local runs with CI's pinned Deno version.
- The lessons-inbox step was not run, because no `lessonsctl.py` exists on this machine.

None of these gaps bears on the gating item.

<sub>Evidence is `file:line` at HEAD `8a3874f` vs `main` (`2909a0a`). DB findings were reproduced on an isolated Supabase stack built from the verbatim migration files; edge findings with Deno 2.7.14. Every survivor was refuted by an agent that did not raise it. Judge scores: grounding 5, calibration 4, scope honesty 5, actionability 5.</sub>

VERDICT: BLOCK
