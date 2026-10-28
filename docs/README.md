# Documentation

Each document owns one contract or operating topic. Generated reports remain outside tracked documentation.

## Reference

- [Interface design](interface-design.md): Phone spacing, lineup controls, Matchup interactions, news, player badges, and brand assets.
- [Architecture](architecture.md): Screen views, versioned cache, receipts, workers, events, and retention.
- [Rookie drafts](draft.md): Linear order, traded slots, and points-per-game ties.
- [Player sources](player-sources.md): Birthdates, injuries, experience, and exact identity matching.
- [IO audit](io-audit.md): Write reductions, final integration counts, and measurement limits.
- [Database readiness catalog](database-readiness-catalog.md): Attested migration phases and database security checks.
- [Dynasty decision tools](dynasty-decision-tools.md): Published ranks, value calculations, Trade Analyzer, and cache rules.
- [Loading rules](instant-loading.md): Saved content, empty results, errors, and layout checks.
- [Matchup forecasts](matchup-forecasts.md): Cached odds, projection coverage, stale inputs, and concurrent publication.
- [Auto-set daily](pre-tipoff-lineups.md): Lineup locks, dispatch, retries, permissions, and recovery.
- [Production migration history](production-migration-history.md): Historical attestations, approved migration ranges, and database recovery.
- [PWA behavior](pwa-live-data.md): Player detail, caching, offline actions, reconnects, updates, and push.
- [Release history attestations](release-history-attestations.md): Local refresh and candidate range checks.
- [Release build provenance](release-build-provenance.md): Artifact identity, recovery, and repeatable exports.
- [Roster lifecycle](roster-lifecycle.md): Ownership, continuous FAAB claims, taxi, reserved trade capacity, and playoffs.
- [Season simulator](season-simulator.md): Historical replay inputs, invariants, and acceptance limits.
- [Source monitoring](source-monitoring.md): Providers, projections, schedules, recovery, and retention.
- [Trade estimates](trade-estimates.md): Frozen quotes, offer attachment, source details, and current revaluation of saved trades.
- [Backend route inventory](supabase-backend-route-inventory.md): Client boundaries, routes, permissions, and measurement rules.
- [Database performance](supabase-performance-capacity.md): Scoring, reads, capacity measurements, and recovery limits.
- [Verification](verification.md): Local setup, verification commands, and release gates.

## Related guides

- [Database release steps](../supabase/RELEASE-DB.md): Baselines, migration order, Edge deployment, operator pause, and rollback.
- [Release 2.4 integration](release-2.4-integration.md): Preserved integration decisions and verification results.
- [Installed iPhone checks](ios-simulator-testing.md): Home Screen installation, native interactions, and captures.
- [Bounded replay acceptance](bounded-replay-acceptance.md): Limits of resumed historical evidence.
- [Load comparison](../scripts/load/README.md): Isolated database workload measurements.
- [Live scoring mutations](../scripts/mutation/live/README.md): Scoring mutation checks and restoration.
- [Postseason mutations](../scripts/mutation/post/README.md): Season transition mutation checks.
- [Browser and soak checks](../tests/e2e/README.md): Browser fixtures and release acceptance.
- [Layout measurements](../tests/e2e/layout-stability-README.md): Local layout setup and reporting.
- [Benchmarks](../scripts/bench/README.md): Capacity fixtures and comparisons.
- [Simulator setup](../scripts/season-sim/README.md): Collection, replay, and cleanup commands.
- [Font generation](../assets/fonts/README.md): Public font assets.
- [Player identity correction](../supabase/functions/_shared/playerIdentityCorrections.md): Reviewed identity mapping and history preservation.
