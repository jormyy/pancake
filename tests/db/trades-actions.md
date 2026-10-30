# Trade action costs

Method: compare main `952580ce` with migrations 05000–05001 on the same restored private database. Use three managers, five interleaved pairs, frozen rows and response bytes. Count nested statements and shared buffers. Accept gains beyond max(10%, baseline spread). Deferred writes and follow-up work count.

| Warm action | Before | After |
| --- | ---: | ---: |
| Proposal nested statements | 1,053 | 853 |
| Three-team proposal nested statements | 1,367 | 1,067 |
| Reanalysis shared buffers | 78,442 | 18,773 |
| Accepted-trade worker nested statements | 897 | 797 |

Responses, logical writes, triggers and queued work match. Reanalysis trades twelve additional statements for fewer buffers. No WAL gain is claimed.

Run measurement commands from the original guarded `fable-a1` mini checkout. Its stack runner enforces its own project and ports. Never run it against another lane's stack.

```sh
node tests/db/trades-actions-stack.mjs
deno run --cached-only --no-lock --node-modules-dir=manual --allow-all tests/db/trades-actions.mjs --mode parity --output ../evidence/parity
deno run --cached-only --no-lock --node-modules-dir=manual --allow-all tests/db/trades-actions.mjs --mode measure --repeats 5 --output ../evidence/final
node tests/db/trades-actions-report.mjs ../evidence/final/results.json --controls ../evidence/control-v3/results.json --output ../evidence/final-summary.json
node tests/db/trades-actions-proof.mjs ../evidence/parity/results.json
node tests/db/trades-actions-reanalysis-parity.mjs
node tests/db/trades-actions-verify.mjs
```

The verification recipe runs the SQL regressions and Deno suite. Stop the stack through its owner with `touch ../stop`. Keep generated outputs outside Git. [Integration checks](../../docs/release-2.12-integration.md) use the separate integration stack.
