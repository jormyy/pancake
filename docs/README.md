# Pancake docs

Operating documentation for the product and its automation. Dated, point-in-time review
records live under [`audits/`](./audits/).

| Document | What it is |
| --- | --- |
| [dynasty-decision-tools.md](./dynasty-decision-tools.md) | Product, engine, cache, and release contracts for Dynasty Rankings and Trade Analyzer. |
| [dynasty-decision-tools-status.json](./dynasty-decision-tools-status.json) | Machine-readable feature and release-gate evidence for the dynasty decision tools. |
| [season-simulator.md](./season-simulator.md) | Historical replay, fixture provenance, real dispatch, source limits, and measured acceptance. |
| [season-autonomy-ledger.md](./season-autonomy-ledger.md) | Acceptance-criteria ledger for the perpetual-season autonomy work: one PASS/FAIL line per criterion with its evidence pointer, plus the checkpoint log. |
| [sleeper-migration.md](./sleeper-migration.md) | Sleeper→ESPN player-source migration: cutover design, degraded-source contract, `years_exp` semantics, and the side-by-side parity run table (raw runs in [`sleeper-migration-parity/`](./sleeper-migration-parity/)). |
| [soak-harness-audit.md](./soak-harness-audit.md) | Forced-red audit of the release-soak harness: each major assertion family broken on purpose to prove its green is trustworthy. |
| [architecture.md](./architecture.md) | Where auth, caches, live updates, scheduled jobs and the API boundary live, plus recent simplifications. |
| [pre-tipoff-lineups.md](./pre-tipoff-lineups.md) | Daily lineup opt-in, tipoff dispatch, lock precedence, retries, and rollback. |
| [verification.md](./verification.md) | Local stack, correctness and benchmark recipes, latest measured results and their limits. |
| [instant-loading.md](./instant-loading.md) | Loading rules, research sources, workflow budgets, and regression gates. |
| [pwa-live-data.md](./pwa-live-data.md) | PWA architecture, cache rules, reconnect recovery, verification, and known limits. |
| [roster-lifecycle.md](./roster-lifecycle.md) | Roster-linked state map: what happens to trade-block listings, lineups, pending claims, and pending offers when a player leaves a roster, and the triggers that enforce it. |
| [source-monitoring.md](./source-monitoring.md) | Source freshness, completeness, failure records, recovery steps, and known limits. |
| [supabase-performance-capacity.md](./supabase-performance-capacity.md) | Local read capacity, paired scoring results, measurement limits, and reproduction links. |
| [supabase-backend-route-inventory.md](./supabase-backend-route-inventory.md) | Inventory of every Edge API route and internal function with its auth model. |
| [evidence/](./evidence/) | Dated performance evidence: what was measured, under what conditions, and what the numbers do and do not claim. |
| [audits/](./audits/) | Dated review ledgers and readiness snapshots (feedback-review hardening, multi-team trade parity, season readiness). |

Related, outside this directory:

- [tests/e2e/README.md](../tests/e2e/README.md) — browser targets, layout sweep, seed, soak, and perpetual-season checks.
- [tests/e2e/layout-stability-README.md](../tests/e2e/layout-stability-README.md) — isolated layout setup, recorder checks, paired captures, and cleanup.
- [scripts/bench/README.md](../scripts/bench/README.md) — local profile setup, paired scoring, and certificate regressions.
- `supabase/sql/functions/by-name/` — canonical sources for every SQL function; edited
  first, then copied into a timestamped migration (`npm run check:db-function-sources`
  enforces parity).
