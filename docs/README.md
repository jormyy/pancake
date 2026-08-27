# Pancake docs

Operating documentation for the product and its automation. Dated, point-in-time review
records live under [`audits/`](./audits/).

| Document | What it is |
| --- | --- |
| [dynasty-decision-tools.md](./dynasty-decision-tools.md) | Product, engine, cache, and release contracts for Dynasty Rankings and Trade Analyzer. |
| [dynasty-decision-tools-status.json](./dynasty-decision-tools-status.json) | Machine-readable feature and release-gate evidence for the dynasty decision tools. |
| [season-autonomy-ledger.md](./season-autonomy-ledger.md) | Acceptance-criteria ledger for the perpetual-season autonomy work: one PASS/FAIL line per criterion with its evidence pointer, plus the checkpoint log. |
| [sleeper-migration.md](./sleeper-migration.md) | Sleeper→ESPN player-source migration: cutover design, degraded-source contract, `years_exp` semantics, and the side-by-side parity run table (raw runs in [`sleeper-migration-parity/`](./sleeper-migration-parity/)). |
| [soak-harness-audit.md](./soak-harness-audit.md) | Forced-red audit of the release-soak harness: each major assertion family broken on purpose to prove its green is trustworthy. |
| [instant-loading.md](./instant-loading.md) | Performance operating plan: top-10 workflows, latency budgets, and the regression gates that enforce them. |
| [pwa-live-data.md](./pwa-live-data.md) | PWA architecture, cache rules, reconnect recovery, verification, and known limits. |
| [roster-lifecycle.md](./roster-lifecycle.md) | Roster-linked state map: what happens to trade-block listings, lineups, pending claims, and pending offers when a player leaves a roster, and the triggers that enforce it. |
| [source-monitoring.md](./source-monitoring.md) | Source freshness, completeness, failure records, recovery steps, and known limits. |
| [supabase-backend-route-inventory.md](./supabase-backend-route-inventory.md) | Inventory of every Edge API route and internal function with its auth model. |
| [evidence/](./evidence/) | Dated performance evidence: what was measured, under what conditions, and what the numbers do and do not claim. |
| [audits/](./audits/) | Dated review ledgers and readiness snapshots (feedback-review hardening, multi-team trade parity, season readiness). |

Related, outside this directory:

- [tests/e2e/README.md](../tests/e2e/README.md) — the multi-season E2E harnesses: seed,
  soak, release soak, browser scenarios, and the perpetual-season simulation.
- `supabase/sql/functions/by-name/` — canonical sources for every SQL function; edited
  first, then copied into a timestamped migration (`npm run check:db-function-sources`
  enforces parity).
