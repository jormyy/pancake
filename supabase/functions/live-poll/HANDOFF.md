# Live-score cost changes

The live tick is 30 seconds. Final saves and the 30-minute correction check keep their existing rules.
No production service, backup, or game-night benchmark runs during this work.

## Expected work per hour

These estimates assume 30 worker starts per hour and seven continuously live games.
They describe job and request counts, not measured swap savings.

| Cut | Before | After | Expected effect |
| --- | --- | --- | --- |
| Live ticks | 180/hour | 120/hour | 60 fewer ingestion and scoring cycles |
| NBA scoreboard sync-run rows | 180/hour | 0 | 180 fewer inserts and 180 fewer completion updates |
| Attempt stamps for active games | 180 calls/hour; 1,260 game-row updates | 0 | Scheduled-game and final-game retry stamps remain |
| Player import resolution | Up to 1,260 calls/hour | Once per game, then on missing or changed identity links | Normal repeated NBA boxes reuse current stored memberships |
| Full game identity checks | Repeated before each live save | Once per game, then after calendar identity changes | Calendar changes invalidate the stored proof under the existing source lock |
| Identical live snapshot saves | Up to 1,260 calls/hour | 0 | No save, row lock, cache write, or audit write for an identical feed |
| Changed live stat input | Every player line | Changed lines | The database computes the delta against its current snapshot under the source lock |
| Live lease renewal | 90 calls/hour | 30 | One renewal per normal worker run; the lease still lasts 90 seconds |
| Work lease renewal | 90 calls/hour | 0 during a normal run | Startup grants five minutes; live runs stop within 115 seconds |

A changing game can still save on each 30-second tick: at most 840 game snapshots/hour for seven games.
Final saves, correction rechecks, source ordering, score publication guards, and stalled-worker recovery remain active.
A newer source timestamp still advances the database watermark, even when player values stay equal.

The cache stores a normalized snapshot and returns it with live work.
This adds cached JSON storage and response bytes, which the separate benchmark should measure.
The worker also sends full input for recovery when another writer changes the stored stats.
Only the changed lines reach the live stat upsert.
External stat, scoreboard, and calendar changes invalidate the corresponding cache.

## Evidence

- The repeated-feed control fails against the original `syncStats.ts`, then passes with this change.
- That control reduces repeated-feed ingestion RPCs from three to zero.
- A one-player correction submits one changed line, while retaining the complete recovery input.
- The final migration applies to a fresh local stack, then again after restoring its baseline function schema.
- Nine SQL suites pass, including 22 new cache checks.
- The stalled-worker race suite passes all six checks.
- The selected Deno run passes 82 tests, with four database fixtures skipped by their existing environment gates.
- The final-stat certification fixture then passes separately against the disposable database.
- Two selected Vitest files pass all eight tests.
- TypeScript, changed runtime Deno checks, SQL source parity, shared-source parity, and diff whitespace checks pass.
- The selector runs all three selected commands successfully. It returns `UNKNOWN` for unmapped SQL and documentation.
- The nine SQL suites above cover those SQL files manually; documentation needs no executable test.
- ESLint reports no errors and two existing array-style warnings in `syncStats.ts`.

Three fixed-port integration fixtures remain unrun: live/injury contention, the generic dispatcher database fixture, and player-import overlap.
Their checks require separate stack ports or a fixture status file.
Local SQL identity, lease, source-order, final-correction, and stalled-race tests cover the changed behavior.
Swap, production load, and the separate game-night benchmark remain unmeasured.

## Commands

Run from this checkout. The temporary local stack uses a unique project ID and database port 64322.
That stack is removed after verification.

```sh
python3 /Users/michaelchen/.local/share/my-ai-skills/main/skills/project-verification/scripts/testselect.py --repo "$PWD" --base e5f1621194e6b15fbb41a2b747f95832df29c207 --log -

deno test --no-lock --no-check --node-modules-dir=none --allow-env --allow-net=127.0.0.1,localhost --allow-read \
  supabase/functions/_shared/syncStats.test.ts \
  supabase/functions/_shared/syncStats.concurrency.test.ts \
  supabase/functions/_shared/syncStats.contention.test.ts \
  supabase/functions/_shared/syncStats.finalScore.test.ts \
  supabase/functions/_shared/syncStats.inactive.test.ts \
  supabase/functions/_shared/syncStats.certification.test.ts \
  supabase/functions/_shared/liveGameTeamHistory.test.ts \
  supabase/functions/_shared/cdnBatch.test.ts \
  supabase/functions/live-poll/runner.test.ts \
  supabase/functions/live-poll/contention.test.ts \
  supabase/functions/live-poll/cache.test.ts \
  supabase/functions/live-poll/lease.test.ts \
  supabase/functions/sync-player-injuries/index.test.ts \
  supabase/functions/dispatcher/worker.db.test.ts \
  supabase/functions/sync-players/concurrentStats.test.ts

deno check --no-lock --node-modules-dir=none \
  supabase/functions/live-poll/runner.ts supabase/functions/_shared/syncRuns.ts \
  supabase/functions/live-poll/cache.test.ts supabase/functions/live-poll/lease.test.ts

SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres PANCAKE_TEST_DB_PORT=64322 \
  deno test --no-lock --node-modules-dir=none --allow-env --allow-read --allow-run=psql \
  --allow-net=127.0.0.1,localhost supabase/functions/_shared/syncStats.certification.test.ts

SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:64322/postgres PANCAKE_TEST_DB_PORT=64322 \
  node tests/e2e/live-poll-stalled-race-db.mjs

npx vitest run tests/invocation-startup.test.ts tests/dispatcher-worker.test.ts
npx tsc --noEmit -p .
node scripts/check-db-function-sources.mjs --check
node scripts/generate-edge-shared.mjs --check
git diff --check
```

The broad Deno command disables test-file type checks because two existing tests have incompatible `RequestInit` declarations.
The changed runtime and new tests pass separate Deno type checks.
SQL tests run through `docker exec` against the disposable database:

- `supabase/functions/live-poll/cache.db.sql`
- `tests/db/live-snapshot-order.sql`
- `tests/db/work-queue-live-poll.sql`
- `tests/db/live-espn-certification.sql`
- `tests/db/live-score-guards.sql`
- `tests/db/final-stat-revisions.sql`
- `tests/db/game-identity.sql`
- `tests/db/live-poll-stalled-retry.sql`
- `tests/db/statement-trigger-empty-sets.sql`

The last suite includes `tests/db/rules-support.sql` before execution.
The score-guard suite receives explicit loopback URL and port variables.

## Changed files

- `supabase/functions/_shared/liveFeed.ts`
- `supabase/functions/_shared/syncStats.ts`
- `supabase/functions/_shared/syncRuns.ts`
- `supabase/functions/live-poll/runner.ts`
- `supabase/functions/live-poll/cache.test.ts`
- `supabase/functions/live-poll/cache.db.sql`
- `supabase/functions/live-poll/lease.test.ts`
- `supabase/functions/live-poll/HANDOFF.md`
- `supabase/sql/functions/by-name/public/assert_nba_game_unambiguous.sql`
- `supabase/sql/functions/by-name/public/get_live_poll_work.sql`
- `supabase/sql/functions/by-name/public/record_live_poll_attempts.sql`
- `supabase/sql/functions/by-name/public/save_live_game_stats_atomic.sql`
- `supabase/sql/functions/by-name/public/save_live_feed_snapshot_atomic.sql`
- `supabase/sql/functions/by-name/public/save_live_cache_invalidate.sql`
- `supabase/migrations/20261214006400_live_path_half_gig.sql`

## Handoff

All edits stay within the assigned paths. No commit, stage, stash, branch change, push, or deploy occurs.
The orchestrator can commit these edits and measure the combined candidate.
Do not regenerate release attestations or rerun the baseline reproduction to finish this change.
