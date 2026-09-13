# Review — `task/t_a4dc0293-hardening` vs `main` (round 3)

**Request changes.** Every round-2 item except S9 is fully fixed; S9 is partly fixed. The new scheduling commit turns CI's database job red for four independent reasons.

Re-reviewed `8a3874f..09676e4` — 4 commits (fix commits `d7636b9`, `bb84804`, `c29e81c`), 61 files, +7,206/−59. Full branch: `main...09676e4` — 157 files, +19,323/−279, 24 commits, 3 migrations.
Five hunt passes (scheduling, edge runtime, client/PWA, a cross-cutting sweep, one unsteered pass), each candidate refuted by an agent that did not raise it. **49 raised / 16 refuted / 33 survived (0 blocker, 6 material, 27 minor).** Four survivors gate.

**The scheduling SQL works when executed. Its tests, and two tests main already has, cannot pass. Merging makes the database check fail on every later PR.**

## Round-2 scorecard

| Item | Status | How I checked |
| --- | --- | --- |
| B2 — retry test leaked a timer (gating) | **Fixed** | CI's command (`node scripts/check-edge-functions.mjs`, Deno 2.7.14, CI's pinned version): `ok \| 116 passed \| 0 failed`, exit 0. |
| S5 — waiver-edit cases 3–5 could not fail | **Fixed** | Handlers re-raise unless the gate message fired (`tests/db/waiver-claim-edit-gates.sql:61,74,88`). Suite exits 0 on a fresh stack. |
| S6 — index comment named a missing index | **Fixed** | `20260912000001:7-13` names `idx_roster_transactions_player_league_recent`. |
| S7 — home-surface comment order | **Fixed** | `lib/home-surface.ts:1-4` matches `:13-14`. |
| S8 — hidden tabs refetched on reconnect | **Fixed** | Both listeners check focus (`hooks/use-focus-async-data.ts:119-135`). The test fails if the gate is removed. |
| S9 — cleanup-list test could not catch a new FK | **Partly fixed** | The set is now derived, but the regex has gaps (item 24). |
| S10 — draft-order body had no deadline | **Fixed** | 45 s overall signal stays linked to the body read (`sync-draft-order/lib.ts:212`, `retry.ts:22-23`). |
| S11 — empty rows under the trades error banner | **Fixed** | `lib/trades-screen-model.ts:125-157` skips only empty rows. Real rows still render. |

## Gating

Gating is a disposition, not a severity. These four are material, not blockers, because production code is correct. They gate because a merge breaks the check for everyone after it, the same bar round 2 used for B2. All four come from `c29e81c`. All four are in tests or generated types, not production code. Any one alone turns the job red. `.github/workflows/test.yml:3-7` runs the job on every PR and every push to main. The types check (`:115`) runs before `test:db` (`:142`), and `test:db` is one `&&` chain (`package.json:58`).

I reproduced each twice on an isolated local Supabase stack built from HEAD's verbatim migrations: once in chain order, once after a fresh `supabase db reset`.

### 1. Generated types are stale · material · **gating** · [VERIFIED]

`types/database.ts:4013-4028`, `:4207`

```
$ npm run check:database-types
types/database.ts is stale; run npm run generate:database-types      exit 1
```

Regenerating gives a 74-line diff. Every hunk is a branch object: the tables `cron_dispatch_state` and `edge_invocations` are missing, three `invoke_*` functions lack `p_now`, and `renew_live_poll_lease` was added by hand in the wrong place. I regenerated with CLI 2.114.0; CI pins 2.109.1. A version difference cannot explain hunks that name branch objects.

**Fix:** run `npm run generate:database-types` against a reset stack and commit the result.

### 2. The migration drops signatures that existing tests and the readiness harness still name · material · **gating** · [VERIFIED]

Cause: `supabase/migrations/20260912000003_scheduling_catchup_and_durable_invocations.sql:49-51`. Broken callers:

- `tests/db/dynasty-decision-inputs.sql:17` — `'public.invoke_dynasty_ranking_views_at_et_time(integer,integer)'::regprocedure`
- `tests/db/season-boundary-gate.sql:12` — `'public.invoke_season_boundary_if_due()'::regprocedure`
- `tests/e2e/db-security-catalog.mjs:112-114` — `has_function_privilege(…, 'public.invoke_edge_function_at_et_time(text,int,int)', …)`. It runs in `production-readiness.yml:184` against the linked production database. So after deploy, the release-readiness harness also fails. That is a separate consequence from the CI failure.

```
psql:tests/db/dynasty-decision-inputs.sql:24: ERROR:  function "public.invoke_dynasty_ranking_views_at_et_time(integer,integer)" does not exist
psql:tests/db/season-boundary-gate.sql:17: ERROR:  function "public.invoke_season_boundary_if_due()" does not exist
probe (db-security-catalog query):  ERROR:  function "public.invoke_edge_function_at_et_time(text,int,int)" does not exist
```

Both SQL files are byte-identical to main. They passed at the round-2 head (`local-phase4/test-db.txt`). `test:db` stops at suite 3 of 22, so the new scheduling tests never run in CI.

- **Production is safe:** the stored cron commands still resolve. I ran all of them in one rolled-back transaction with no error.
- **Fix:** add `timestamptz` to each type list: `(integer,integer,timestamptz)`, `(timestamptz)`, `(text,int,int,timestamptz)`. `tests/rls-grants.test.ts:84-87` names the old signature too (item 11).

### 3. Two new tests put psql variables inside `DO $$` bodies · material · **gating** · [VERIFIED]

`tests/db/edge-invocation-reconcile.sql:19` and `tests/db/live-poll-gate-and-lease.sql:15-16,23,26,28`

```sql
RAISE NOTICE 'reconciled rows: %', :reconciled;
```

psql does not substitute variables inside dollar-quoted bodies. Both files exit 3 with `syntax error at or near ":"` before any assertion runs. WORKLOG.md iteration 7 says these tests were "unrun here".

The code under them is correct. I moved each value out through `set_config` and read it back with `current_setting`. Both patched files exit 0, and the reconcile pass reports 4 rows.

**Fix:** after each `\gset`, run `SELECT set_config('t.x', :'x', false);`. Inside the block, read `current_setting('t.x')`.

### 4. The waiver-projection fixture places players on waivers that already cleared · material · **gating** · [VERIFIED]

`tests/db/waiver-claim-projection.sql:23-25` (fails at `:28`)

```
psql:tests/db/waiver-claim-projection.sql:28: ERROR:  This player is no longer on waivers.
```

The fixture sets `placed_on_waivers_at = now() - interval '3 days'`. The trigger `trg_waiver_clears_at` always overwrites `clears_at` with `placed_on_waivers_at + 48 hours` (`20260226000003_functions.sql:164-174`). The stored `clears_at` is one day in the past, and the create gate needs `clears_at > now()`. So the test fails on every run.

**Fix:** set `placed_on_waivers_at = now() - interval '1 hour'` and drop the `clears_at` value.

## Material — pre-merge asks (not gating)

### 5. One failing member now blocks lineup auto-set for everyone · material · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

`supabase/functions/lineup-optimizer/index.ts:178`, loop at `:188-217`

```ts
.order('last_optimized_at', { ascending: true, nullsFirst: true })
```

The loop has no per-member try/catch. `touchOptimizerSetting` runs only after a member succeeds (`:216`). A member whose auto-set keeps throwing never gets a new timestamp, so from the next run on that member sorts first. Then every 10-minute run throws on it before it reaches anyone else. Main had no `ORDER BY`, so the same member blocked only the members after it.

- **Why not gating:** auto-set is opt-in, users keep their stored lineups, and I did not reproduce a persistently throwing member. The refuter named `assert_roster_within_active_limit` as a likely cause.
- **Fix:** wrap each member's body in try/catch, log the error, and continue. Or touch a `last_attempted_at` on failure.

### 6. The missing-stats wake does not fetch the missing stats · material · pre-merge ask · [WORTH CHECKING — reasoned, not executed]

Gate: `20260912000003:317-325`. Worker: `supabase/functions/live-poll/index.ts:74-81` and `:136`.

```ts
const shouldSync = nowActive > 0 || allDone || (activeGames?.length ?? 0) > 0
```

The gate wakes live-poll for a Final game with no box score, but the branch did not change the sync decision. With no games today, the CDN slate is empty, and each wake returns `idle` (`:81`). The game leaves the two-day window and its stats are never fetched. The cost is an estimated 780 wakes that day (the per-minute cron over about 13 hours), each writing an `edge_invocations` row and a `sync_runs` row. With games later today, the stats arrive at first tip.

- **The docs overstate it:** `docs/source-monitoring.md:39-40` says the game "is recovered on the next tick", and WORKLOG.md:326 says ops#11 is "fixed". The test (`live-poll-gate-and-lease.sql:7-16`) checks only that the wake fires.
- **Why not gating:** it is no worse than main, which never woke for this case.
- **Fix:** when a candidate-date Final game has no stats, have live-poll call `syncStatsForDates(candidateDates)`. Or reword the docs and WORKLOG.

## Minor — pre-merge asks

7. **Catch-up covers less than the comments say.** `20260912000003:248-249`, `docs/source-monitoring.md:32-33`. In EST, every daily job's second tick falls exactly on its target time, so no later tick is left to catch up a missed one. The ranking job ticks only on Mondays (`20260817000002:322`), so the Tuesday case in `tests/db/cron-dispatch-catchup.sql:29` never happens in production. A late tick does now fire, which is a real gain. Fix the wording, or add one tick after the target.
8. **Deploy day can dispatch twice.** `20260912000003:19-23` seeds no state. In EDT, a job the old gate ran at its first tick fires again at its second tick if the deploy lands between them. Examples: `process-waivers` at 07Z and 08Z, `season-boundary` at 13Z and 14Z. Seed today's period in the migration.
9. **"A failed invoke rolls it back" is too broad.** `20260912000003:5-7`. Only synchronous raises roll back (missing URL or token). A pg_net 5xx or timeout leaves the day claimed with no retry. This matches main.
10. **The new tables do not enable RLS.** `20260912000003:19-46`. `sync_runs` and `live_poll_leases` do. Grants are revoked, so nothing is exposed, but the Supabase linter will flag it.
11. **A grants test still checks the dropped signature.** `tests/rls-grants.test.ts:84-87` passes only because the old migration text survives. Point it at `(text, int, int, timestamptz)`.
12. **The live-poll test deletes real games.** `tests/db/live-poll-gate-and-lease.sql:6`. `player_game_stats` has no `ON DELETE` rule, so the test errors on any in-season database with stats. CI's fresh stack is unaffected.
13. **The function catalog was edited by hand.** `supabase/sql/function-catalog.json:77-78`, `:132-133`, `:186-187`, `:202-203`. Main kept these four pairs in the generator's `localeCompare` order (`scripts/check-db-function-sources.mjs:680`); the branch reversed them, so the next regeneration churns. The check still passes (`check:db-function-catalog` exit 0).
14. **The reconcile code and its header disagree.** `20260912000003:184` fails only on `>= 400`; `:11-12` says "non-2xx". Nit.
15. **Home shows two Retry controls.** `app/(tabs)/index.tsx:213` (banner) and `:309-321` (new error card) both render on error with no matchup. Nit.
16. **The trades-model test covers one side.** `tests/lib/trades-screen-model.test.ts:72-82` never checks that real rows still render under an error. Nit.
17. **A test has a dead branch.** `tests/service-worker.test.ts:217`: `url.endsWith('renamed.js') ? html() : html()`. Nit.

## Minor — post-merge tracker

18. **Long runs may log false failures.** `20260912000003:135` (30 s pg_net timeout, from main) and `:184-192` (new). A timed-out request becomes a failed `cron:<fn>` row. It is unknown whether hosted Supabase stops the run when the caller disconnects, so this is plausible, not confirmed. It fails safe: noise, not data loss.
19. **Nothing acts on a lost lease.** `supabase/functions/_shared/leaseHeartbeat.ts:25-28` stops after one renewal error, and `live-poll/index.ts:42-54` never reads `heartbeat.lost`. It is never worse than main, which had no renewal. `leaseHeartbeat.ts:4-5` implies the caller stops; it does not.
20. **Update checks can reload the page mid-task.** `app/+html.tsx:25-28` adds an `online` check and an hourly check. A new bundle then reloads the page (`:44-46`, unchanged) while a user may be typing a bid. It happens only when a deploy changed the bundle. Plausible.
21. **Some failures get two rows.** An edge function that throws writes a failed `<fn>` row, and reconcile adds a failed `cron:<fn>` row (`serve.ts:17-19`, `syncRuns.ts:77-84`, `20260912000003:184-192`).
22. **The health check never reads the new rows.** `tests/e2e/configured-source-health.mjs:16-19` reads a fixed list, but `docs/source-monitoring.md:34-38` presents `cron:*` rows as the health surface.
23. **The scheduling tests have gaps.** `cron-dispatch-catchup.sql` uses only EST dates, with no EDT case and no rollback-on-raise case. `live-poll-gate-and-lease.sql` has no "Final game with stats does not wake" case.
24. **The S9 regex has gaps.** `tests/e2e-harness-fixtures.test.ts:151` misses `REFERENCES players` without `(id)`, treats `RESTRICT`/`NO ACTION` as safe, and mishandles a multi-line `ON DELETE`. No such table exists today.
25. **Edit errors read as load errors.** `hooks/use-trade-block.ts:135` puts add/remove failures in the load error. The new gates then hide "No listings yet." under "Failed to load trade block". The same happens after a failed load-more (`use-trades-feed.ts:103`).
26. **A retry listener stays attached.** `supabase/functions/_shared/retry.ts:22-23` leaves one abort listener per discarded 5xx attempt on the caller's signal. Every current caller passes a fresh signal. Nit.
27. **A renewal can finish after release.** At `leaseHeartbeat.ts:22-28`, a renewal still in flight after `stop()` can log one false "lease lost". Nit.
28. **The finalization test checks only the helper.** `supabase/functions/_shared/finalizationWrite.test.ts` stays green if the call-site filter at `syncScores.ts:534-536` is reverted.
29. **A boundary failure can be lost.** At `syncRuns.ts:61,65`, the failure summary is dropped when `startSyncRun` failed. Season-boundary still returns 200, so reconcile never sees it. It needs two faults at once. Nit.
30. **Some tests check only source text.** `tests/ux-state-contracts.test.ts`, `tests/lib/roster-add-flow-message.test.ts` and `tests/edge-scheduling-contracts.test.ts` match strings in the source. Partly by design.
31. **An install can leave no offline shell.** `public/sw.js:62` skips a non-ok `/` but the install still succeeds, and activate deletes the old shell (`:78`). Pre-existing.
32. **The heartbeat test depends on timing.** `leaseHeartbeat.test.ts:10-37` uses 5 ms intervals against 30–50 ms sleeps. It could flake on a loaded runner. Nit.
33. **Edit and create can deadlock.** They lock in a different order (`create_waiver_claim_atomic.sql:163`). Pre-existing on main; Postgres aborts one side. Note only.

**Top asks: items 1–4 gate; each is a small test or types fix. Items 5–6 should land before merge. Everything else is minor.**

## False alarms cleared (16)

- **Claim-key collision on `et-time:sync-rankings` today.** The old daily job was re-scheduled under the same job name to the weekly function (`20260817000002:317-324`). The scratch `cron.job` table shows one writer.
- **Future collision if a daily `sync-rankings` job is added.** Hypothetical; no such job exists.
- **"Deno 116/0" was only a forecast.** I ran it: 116 passed, 0 failed.
- Also refuted: a stale-response purge, an unlocked waiver window read, the projection test's label (its header already says it pins current behaviour), reconcile idempotence flake, indexes without `CONCURRENTLY` (disclosed, 5 s lock timeout), a tight draft-order body budget (fails safe), live job-key locks in a test, waiver message wording (copied from main), home-directory paths in evidence, retry abort precedence, the finalization grace reset (intended and commented), per-batch waiver notifications (intended), and a sticky focus error (unchanged from main).

## Checked and solid

- **Once per period:** `claim_cron_dispatch` (`20260912000003:69-76`) holds under concurrent ticks, and rolls back with the transaction. `cron-dispatch-catchup.sql` passes, and its counts would change if the claim or the time gate were removed.
- **On-time behavior matches main** in EDT and EST for all five gated jobs (`process-waivers`, `sync-players`, `sync-schedule`, `nba-sync-rankings`, `season-boundary`). Checked against the schedules in the scratch `cron.job` table.
- **Reconcile and lease code** (`20260912000003:146-207`, `:331-354`) pass their own assertions once the test harness is repaired. The `net._http_response` columns match pg_net 0.20.4.
- **Canonical sources:** all eight `by-name` files match the migration bodies byte for byte. `check:db-function-catalog` exits 0.
- **Waiver edit authorization** (`edit_waiver_claim_atomic.sql:30-52`) scopes the claim to the caller's member and league. EXECUTE is service_role only.
- **Secrets:** none in the added lines. Only placeholder test tokens.
- **Suites on a scratch copy of HEAD:** vitest 697/697, `tsc` (app and tests) exit 0, Deno 116/0. 17 of 22 `test:db` suites pass, including all six Node suites run with edge functions served. The five that fail are items 2–4.
- **Client:** focus gating, trades error rows, service-worker caching rules, and quick-add callers all hold.

## Coverage caveat

- There is no remote and no CI run. CI claims come from CI's own commands run locally, with CI's pinned Deno. The types were regenerated with Supabase CLI 2.114.0, not CI's 2.109.1.
- Items 5 and 6 are reasoned from source, not executed. Item 18 depends on hosted-runtime behavior I could not observe.
- No UI change was exercised in a browser. The e2e harness (seed, perpetual, soak, browser smoke) was read, not run. The ~7,000 new lines under `docs/evidence/` were scanned only for secrets.
- The minor tail was refuted in three batches, one agent per group, not one agent per candidate.
- `lessonsctl.py propose` was not run. No `lessonsctl.py` exists on this machine (`command not found`, exit 127). A search of the home directory found no lessons tool or inbox.
- This is an independent judge pass, not a self-review.

None of these gaps bears on the gating items. Each was reproduced.

<sub>Evidence is `file:line` at HEAD `09676e4` vs `main`. DB findings were reproduced twice on an isolated Supabase stack built from the verbatim migration files; edge findings used Deno 2.7.14. Ledger: 49 candidates, 16 refuted, 33 survived. Judge scores (an independent agent, about 40 citations spot-checked): grounding 4, calibration 4, scope honesty 5, actionability 5. Its five corrections are applied.</sub>

VERDICT: BLOCK
