# Roster action costs

Method: compare main `952580ce` with migration 05100 and the narrower waiver-worker projection. Use the restored private database, three managers, and five interleaved pairs per scenario. Compare all mutated rows and response bytes. Count nested statements, buffers and actual HTTP payloads. Reject gains within baseline spread or ten percent.

| Warm action | Before buffers | After buffers |
| --- | ---: | ---: |
| Move to IR | 909 | 431 |
| Activate IR with lineup bench | 895 | 437 |
| FAAB Taxi worker | 2,632 | 1,704 |

The frozen gate passed 186 comparisons. Logical results, game locks, trigger effects and queued work match. No latency gain is claimed. The uninterrupted final Edge replay was not verified; fifteen worker HTTP pairs passed in the lane.

Run measurements from the original guarded `fable-a2` mini checkout. Its stack runner enforces its own project and ports. Never use another lane's stack.

```sh
node tests/db/roster-actions-stack.mjs
node tests/db/roster-actions.mjs --mode=parity --label=final --files=private/roster_status_game_started.sql --worker-projection
node tests/db/roster-actions.mjs --mode=measure --label=final --files=private/roster_status_game_started.sql
node tests/db/roster-actions.mjs --mode=tests --tests=roster-status-game-lock,compound-activation-source,roster-activation-lock-order
node tests/db/roster-actions-http.mjs --measure --invocation --rotate-manager --label=final-http --files=private/roster_status_game_started.sql
node tests/db/roster-actions-report.mjs ../evidence/final-samples.json ../evidence/final-summary.json
```

Stop through the stack owner with `touch ../stop`. The HTTP runner uses the cleanup helper and instrumented API/worker entries. Keep generated outputs outside Git. [Integration checks](../../docs/release-2.12-integration.md) retain roster and cache regressions.
