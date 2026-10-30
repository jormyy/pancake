# Lineup and draft action costs

Method: compare main `952580ce` with migration 05200 and narrower optimizer/draft-order reads. Use three managers and five interleaved pairs per action. Freeze time and identifiers in the private fixture. Compare raw responses and all changed rows, including deferred writes. Accept gains beyond baseline spread or ten percent.

| Measurement | Before | After |
| --- | ---: | ---: |
| Future auto-set shared buffers | 3,712 | 3,199 |
| Auto-set button DB response bytes | 100% | 28.458% |
| Optimizer DB response bytes | 100% | 43.473% |
| Pre-tipoff DB response bytes | 100% | 25.053% |
| Draft-order sync DB response bytes | 100% | 60.806% |

Final action responses, permissions, locks, rows and queued work match. The SQL gate passed 92 comparisons and rejected 184 mutations. No latency gain is claimed. The Taxi auction failure supplied for main is pre-existing; keep its regression.

Run from the original guarded `fable-a3` mini checkout. Its harness enforces its own project, ports and resource limits. Never use another lane's stack.

```sh
node tests/db/lineup-draft-mini.mjs
node tests/db/lineup-draft-actions.mjs quality supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql
ACTION_CONNECTION=warm node tests/db/lineup-draft-actions.mjs bench supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql
ACTION_CONNECTION=fresh node tests/db/lineup-draft-actions.mjs bench supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql
ACTION_HTTP_BENCH=1 ACTION_HTTP_REPEATS=5 ACTION_HTTP_PAIRS=5 node tests/db/lineup-draft-http.mjs supabase/sql/functions/by-name/public/auto_set_lineup_atomic_unchecked.sql supabase/functions/lineup-optimizer/index.ts supabase/functions/lineup-optimizer/projections.ts supabase/functions/lineup-optimizer/preTipoff.ts supabase/functions/sync-draft-order/lib.ts
node tests/db/lineup-draft-verify.mjs
node tests/db/lineup-draft-report.mjs
```

Stop through the stack owner with `touch ../stop`. Keep generated reports outside Git. [Integration checks](../../docs/release-2.12-integration.md) retain cache, auto-set and lock regressions.
