# League action costs

Method: compare main `952580ce` with migrations 05300–05302 on the same restored private database. Use three managers and five interleaved pairs for ordinary, wide, bounded, fractional and rejection cases. Compare response bytes and every mutated row, including timer and notification effects. Accept work reductions beyond baseline spread or ten percent.

| Warm action | Before buffers | After buffers |
| --- | ---: | ---: |
| Dynasty forecast inputs | 696 | 615 |
| Visible player totals | 589 | 438 |
| Player search control | 2,869 | 2,869 |

Batched rankings and shared game selection preserve values, ordering and permissions. Deletion avoids unarmed timer writes. No production latency gain is claimed.

Run from the original guarded `fable-a4` mini checkout. The stack wrapper enforces its own project and ports and stops its stack on exit.

```sh
node tests/db/league-actions-stack.mjs -- node tests/db/league-actions.mjs --parity --variants --candidate=supabase/migrations/20261214005300_batched_dynasty_rankings.sql,supabase/migrations/20261214005301_delete_unarmed_timer_writes.sql,supabase/migrations/20261214005302_shared_visible_games.sql --label=frozen
node tests/db/league-actions-stack.mjs -- node tests/db/league-actions.mjs --timer-locks
node tests/db/league-actions-stack.mjs --migrate -- node tests/db/league-actions.mjs --recipes --only=dynasty-decision-inputs,draft-goal-behavior,visible-player-totals --label=installed
node tests/db/league-actions-report.mjs ../evidence
node --test tests/db/league-actions-metrics.test.mjs
```

Use `--direct --scoped --capture --variants` instead of `--parity` for the measured matrix. Keep generated reports outside Git. [Integration checks](../../docs/release-2.12-integration.md) cover installation and schema equality.
