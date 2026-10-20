# Documentation

Each topic has one owner below. Generated reports stay outside tracked documentation.
The production migration history remains an operational record.

| Document | Scope |
| --- | --- |
| [architecture.md](architecture.md) | Code boundaries, auth, change hints, and season transitions. |
| [database-readiness-catalog.md](database-readiness-catalog.md) | Attested migration phases and database security checks. |
| [dynasty-decision-tools.md](dynasty-decision-tools.md) | Published ranks, value engine, Analyzer, and cache rules. |
| [instant-loading.md](instant-loading.md) | Loading, retained content, empty results, and layout gates. |
| [pre-tipoff-lineups.md](pre-tipoff-lineups.md) | Auto-set daily, locks, dispatch, retries, and rollback. |
| [production-migration-history.md](production-migration-history.md) | Historical release attestations and migration recovery records. |
| [pwa-live-data.md](pwa-live-data.md) | Public caching, private snapshots, offline actions, updates, and push. |
| [release-build-provenance.md](release-build-provenance.md) | Build identity, artifact recovery, and stable exports. |
| [roster-lifecycle.md](roster-lifecycle.md) | Ownership cleanup, waivers, taxi, atomic trade plans, and playoffs. |
| [season-simulator.md](season-simulator.md) | Historical replay, source classes, invariants, and acceptance. |
| [source-monitoring.md](source-monitoring.md) | Providers, freshness, dispatch, recovery, and retention. |
| [supabase-backend-route-inventory.md](supabase-backend-route-inventory.md) | Client boundaries, API routes, access rules, and measurement rules. |
| [supabase-performance-capacity.md](supabase-performance-capacity.md) | Scoring and read contracts, profiles, and measurement limits. |
| [verification.md](verification.md) | Local setup, focused checks, and release workflow prerequisites. |

## Related guides

- [Browser and soak checks](../tests/e2e/README.md)
- [Layout setup and measurements](../tests/e2e/layout-stability-README.md)
- [Benchmark setup and comparisons](../scripts/bench/README.md)
- [Simulator setup and cleanup](../scripts/season-sim/README.md)
- [Font generation](../assets/fonts/README.md)
- [Reviewed player identity correction](../supabase/functions/_shared/playerIdentityCorrections.md)
