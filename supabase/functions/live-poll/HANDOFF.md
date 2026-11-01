# Live-score architecture

The default public path polls every thirty seconds while games are live. It writes status transitions, final stats, and thirty-minute recovery checkpoints.

The public route contains no Supabase client or user data. Phones use the shared scoring formula over their authorized saved lineup basis. A saved official final ignores public deltas. Realtime still invalidates scores and instant actions.

`LIVE_SCORES_OFF=1` on the public route restores database mode. The worker reads the same response as the phones. Without `LIVE_SNAPSHOT_BASE_URL`, the worker retains database mode. See [the architecture guide](../../../docs/live-score-architecture.md) for setup and limitations.

## Retained ingestion path

These parts remain necessary for the off switch, checkpoints, final saves, and corrections:

| Part | Purpose |
| --- | --- |
| `runner.ts` | Runs bounded thirty-second ticks and handles leases and retries |
| `_shared/liveFeed.ts` and `_shared/syncStats.ts` | Verify provider identity, completeness, ordering, and final data |
| Player-resolution and ambiguity checks | Reject conflicting identities and import verified missing players |
| Live snapshot cache | Avoid identical writes and preserve source watermarks |
| Score input revisions and publication guards | Prevent stale or uncertified official scores |
| Final and stalled-worker retries | Preserve recovery and correction behavior |

Only database mode runs ordinary per-tick live saves. With seven continuously live games, its upper bound remains 840 game saves per hour. Public mode does not use that rate.

The retained path caches verified player identities, skips identical live snapshots, and writes changed stat lines. Calendar or external stat changes invalidate cached proofs. Final certification remains complete. A newer source revision still advances the watermark.

## Verification

The original lane checks cover source ordering, complete final boxes, conflicting identities, lease races, and unchanged-feed writes. The regression audit at the requested earlier commit finds no permission mismatches. Two old statistics and unchanged-screen fixture assumptions predate these changes; their fixtures are repaired.

The current checks include the thirty-minute checkpoint, public-source fallbacks, shared overlay, hidden polling, outage recovery, other-team screens, saved history, and ten-phone official corrections. Focused results live outside the repository in the game-night evidence folder.

Run the current local replay through `node scripts/bench/game-night/run.mjs --help`. It owns unique ports and a disposable loopback stack. Use `verify-phone-history.mjs` for the real ten-phone correction check. The runner stops its own stack after completion.

The complete performance series and held-out result remain required. Functional tests establish no swap gain. No production or deployed validation occurs in this work.

Queued live ingestion takes the first available worker slot before older asynchronous jobs. The dispatcher still admits at most four active workers and thirty-two claims per call. Explicit pause and reduced-health rules stay active. The live-priority SQL test fails before this change and passes in normal and degraded modes afterward. Short-work, concurrency, health, and background-fairness checks pass.
