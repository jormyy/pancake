# Release 2.11 integration

The baseline is release 2.10.2 at `892b6bca`.
All seven steps are included in the requested order.
Each merge commit uses `[skip ci]`.

| Step | Source | Merge |
| --- | --- | --- |
| ESPN primary ingestion | `fb6e5303` | `3e3f29cb` |
| Request cuts and recovery polling | `5855c25f` | `7cd613c7` |
| Lock icons and 5yr/3yr badges | `8c5db8d9` | `29609d77` |
| Non-locking pending offers | `d663163e` | `82e998f3` |
| Exponent-5 trade curve | `e1065226` | `2a73146a` |
| Auto-set keeps starters | `424c19da` | `4c76d5c7` |
| Game-night scheduler | `024bf25b` | `ad4ff871` |

The curve includes exponent commit `ced7f75a`, spot value 25, and a 5% fair band.
L4 migrations 029/030/031 become 035/036/037.
The combined history has 710 migrations with unique versions through `20261214003800`.
Integration migration 038 fixes forecast requests raised during league deletion cascades.

The seven merge deltas do not change the same SQL or TypeScript function body twice.
Shared files retain these combined behaviors:

| Functions | Combined behavior |
| --- | --- |
| `TradeAssetColumn`, `PlayerRow`, `PickRow`, `readTradeAssetLocks` | Icons explain accepted-trade and claim locks. Pending offers allow selection. |
| `readTradeAssetLocks`, `mapTradeRow` | Trading locks and published curved analysis assets coexist. |
| `public.dispatch_work`, `private.work_execute` | Essential live totals run during shed while existing ingestion, trade, and waiver work remains scheduled. |
| `private.enqueue_matchup_forecasts`, `private.complete_forecast_input_chunk` | Step 7 retains bounded scans and adds expiry wakeups in migration 037. |
| `private.queue_matchup_forecasts` | Migration 038 retains step 7's coalesced requests and skips parents removed during deletion cascades. |

The current `refresh-views` worker returns HTTP 200 for a scheduler payload but calls ordinary view refresh.
The integrated worker calls the chunk handler.
Apply the earlier migrations through 033, deploy updated `refresh-views`, then apply 035–038.
Deploy the remaining Edge functions and frontend afterward.
The orchestrator's DB-first order is incompatible with migration 036.
The exact failure is recorded in [RELEASE-DB.md](../supabase/RELEASE-DB.md).

Verification uses only private mini project `pt4bafabler211` and ports 641xx.
The shared lock preceded stack startup.
The backup rehearsal passes all 710 migrations. Six generator and catalog checks pass.
All 36 SQL files and five acceptance races pass. The races check 50 assertions.
The affected Deno suite passes 75 tests. The season harness passes 359 tests.
Live replay publishes all 11 recorded changes with a matching score oracle and timeout recovery.
Its p95 lag is 82.97 seconds against the branch's 90-second limit.
Quality, lint, and every typecheck pass.
Vitest covers 4,899 passing tests and 48 skipped tests after rerunning the corrected release-note check.
Browser verification is in progress.
