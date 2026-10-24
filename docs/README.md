# Documentation

Each document owns one contract or operating topic. Generated reports remain outside tracked documentation.

## Reference

- [Architecture](architecture.md): Code boundaries, authorization, change hints, and season transitions.
- [Database readiness catalog](database-readiness-catalog.md): Attested migration phases and database security checks.
- [Dynasty decision tools](dynasty-decision-tools.md): Published ranks, value calculations, Trade Analyzer, and cache rules.
- [Loading rules](instant-loading.md): Saved content, empty results, errors, and layout checks.
- [Auto-set daily](pre-tipoff-lineups.md): Lineup locks, dispatch, retries, permissions, and recovery.
- [Production migration history](production-migration-history.md): Historical attestations, approved migration ranges, and database recovery.
- [PWA behavior](pwa-live-data.md): Player detail, caching, offline actions, reconnects, updates, and push.
- [Release build provenance](release-build-provenance.md): Artifact identity, recovery, and repeatable exports.
- [Roster lifecycle](roster-lifecycle.md): Ownership, waivers, taxi, trade plans, and playoffs.
- [Season simulator](season-simulator.md): Historical replay inputs, invariants, and acceptance limits.
- [Source monitoring](source-monitoring.md): Providers, projections, schedules, recovery, and retention.
- [Backend route inventory](supabase-backend-route-inventory.md): Client boundaries, routes, permissions, and measurement rules.
- [Database performance](supabase-performance-capacity.md): Scoring, reads, capacity measurements, and recovery limits.
- [Verification](verification.md): Local setup, verification commands, and release gates.

## Related guides

- [Browser and soak checks](../tests/e2e/README.md): Browser fixtures and release acceptance.
- [Layout measurements](../tests/e2e/layout-stability-README.md): Local layout setup and reporting.
- [Benchmarks](../scripts/bench/README.md): Capacity fixtures and comparisons.
- [Simulator setup](../scripts/season-sim/README.md): Collection, replay, and cleanup commands.
- [Font generation](../assets/fonts/README.md): Public font assets.
- [Player identity correction](../supabase/functions/_shared/playerIdentityCorrections.md): Reviewed identity mapping and history preservation.
