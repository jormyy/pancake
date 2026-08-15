# Pancake docs

Operating documentation for the product and its automation. Dated, point-in-time review
records live under [`audits/`](./audits/).

| Document | What it is |
| --- | --- |
| [season-autonomy-ledger.md](./season-autonomy-ledger.md) | Acceptance-criteria ledger for the perpetual-season autonomy work: one PASS/FAIL line per criterion with its evidence pointer, plus the checkpoint log. |
| [sleeper-migration.md](./sleeper-migration.md) | Sleeper→ESPN player-source migration: cutover design, degraded-source contract, `years_exp` semantics, and the side-by-side parity run table (raw runs in [`sleeper-migration-parity/`](./sleeper-migration-parity/)). |
| [soak-harness-audit.md](./soak-harness-audit.md) | Forced-red audit of the release-soak harness: each major assertion family broken on purpose to prove its green is trustworthy. |
| [instant-loading.md](./instant-loading.md) | Performance operating plan: top-10 workflows, latency budgets, and the regression gates that enforce them. |
| [supabase-backend-route-inventory.md](./supabase-backend-route-inventory.md) | Inventory of every Edge API route and internal function with its auth model. |
| [audits/](./audits/) | Dated review ledgers and readiness snapshots (feedback-review hardening, multi-team trade parity, season readiness). |

Related, outside this directory:

- [tests/e2e/README.md](../tests/e2e/README.md) — the multi-season E2E harnesses: seed,
  soak, release soak, browser scenarios, and the perpetual-season simulation.
- `supabase/sql/functions/by-name/` — canonical sources for every SQL function; edited
  first, then copied into a timestamped migration (`npm run check:db-function-sources`
  enforces parity).
