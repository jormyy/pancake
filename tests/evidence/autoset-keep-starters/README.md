# Auto-set keeps starters

The private Mac mini stack uses project `pt4bafableas` and ports `640xx`.
The source backup is `pancake-db-backup-2026-10-28`.
Michael's member in OFFICIAL LEAGUE is `9fe20af7-b2fb-4ab6-bd42-2e2e7ccc5dd9`, Mike's Minions.
The fixture contains his 25 roster players and both stored 10-player lineups.
The replay evaluates each date before tipoff. It does not change game-time locks.

| Date | Original pre-tipoff starters | Fixed starters |
| --- | ---: | ---: |
| Thursday 2026-10-29 | 4/10 | 10/10 |
| Friday 2026-10-30 | 10/10 | 10/10 |

Thursday loses PF, G, F, and three UTIL slots with the original code.
Playing projections stay at 140.27 points on Thursday and 354.99 on Friday before and after.
Friday's reported empty slots do not reproduce from this backup. Its slate has enough playing players.
The future-date optimizer and the manual remaining-season optimizer assign each date independently.
There is no day-forward lineup copy path.

The assignment helper is `supabase/functions/_shared/autoSetAssignments.ts`. Both date and pre-tipoff workers use it.
SQL completion retains starters, fills open slots, and can move unlocked eligible starters to make room for a bench fallback.
The canonical SQL changes are `public.auto_set_lineup_atomic_unchecked` and `public.apply_pre_tipoff_lineup`.
Their callers remain `public.auto_set_lineup_atomic` and `public.auto_set_lineup_service_atomic`.
`public.get_pre_tipoff_lineup_context` already includes no-game roster players and stored starters.

Start the mini stack with `PERF_LAB_ON_MINI=1 PERF_LAB_LANE=fable-ui26 PERF_LAB_PROJECT=pt4bafableas PERF_LAB_PORT_PREFIX=640 PERF_LAB_TLS_SELF_SIGNED=1 node tests/e2e/autoset-keep-starters-stack.mjs`.
Put copies of schema.sql and data.sql in the lane's backup directory first.
Remove the lane's stop file before starting another browser stack.
Run `node tests/e2e/autoset-keep-starters-fixture.mjs` after restoration.
Run `deno run --cached-only --node-modules-dir=manual --allow-env --allow-read --allow-write tests/e2e/autoset-keep-starters-replay.mjs ../autoset-after.json` for the fixed replay.
The original replay uses release 2.10.2 source at `892b6bca`.
Touch the lane's `stop` file after verification. The stack runner stops the stack, restores its configuration, and deletes copied backups.

## Verification

The two agent-browser screenshots use a separate automation session at 390 × 1600.
[Thursday screenshot](2026-10-29-after-390.png) and [Friday screenshot](2026-10-30-after-390.png) show all starting rows.
The private game times were delayed to replay both stored dates before tipoff. Their original values were restored afterward.
The home responses contain ten populated starting slots for Michael on both dates.
External browser requests are blocked. The database and Edge runtime reject external HTTP.
No production system was contacted.

Focused Vitest passes 921 tests across nine files. The final focused lineup run passes 16 tests, including signed projections and UTIL ordering.
The full Vitest run was executed once: 3,933 passed, 852 failed, and 48 skipped across 521 files.
The failures came from six files. All six pass in the 921-test focused rerun after the fixes below.
The migration and security attestations were regenerated from the private mini's 702-migration history.
The rankings reconnect fixture now uses the league day for its cache, matching the hook and avoiding an Eastern/Pacific midnight mismatch.
The final Edge suite passes 40 tests. It covers manual, scheduled, future empty, playing replacement, locked, and pre-tipoff paths.
The SQL recipe passes eleven checks, including an eligible starter move that fills a blocked slot. Existing idempotence, optimizer default, and historical lock recipes also pass.
`npm run check:quality`, `npm run lint:all`, `npm run typecheck`, and `npm run typecheck:tests` pass on Node 22.
The node_modules symlink was retained. No dependency installation was needed.

Cleanup passed. The private stack stopped, its configuration was restored, and copied backups were deleted.
The owned automation browser session closed. `cleanup.json` records the backup hashes and cleanup receipt.

Run `node tests/e2e/autoset-keep-starters-db.mjs` with the same private mini environment for the SQL-only verification.
It starts an empty private stack, reproduces the flexible-slot gap with the earlier SQL, verifies the repair, regenerates the attestations, and stops the stack.
