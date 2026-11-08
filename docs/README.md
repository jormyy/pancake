# Documentation

Start with the guide that matches the change.

| Guide | Use it for |
| --- | --- |
| [Architecture](architecture.md) | Code ownership, screen views, caching, and offline actions |
| [Data flow](data-flow.md) | Requests, live overlays, refreshes, and statistics windows |
| [Verification](verification.md) | Local setup, focused checks, browser tests, and release gates |
| [Release artifacts](release-build-provenance.md) | Build identity, recovery, and migration attestations |
| [Migration history](production-migration-history.md) | Historical aliases, fingerprints, and forward recovery |
| [Live scores](live-scores.md) | Public snapshots, official results, rollback, and usage limits |
| [Daily lineups](pre-tipoff-lineups.md) | Pins, locks, automatic selection, and failure recovery |
| [Roster lifecycle](roster-lifecycle.md) | Claims, IR, taxi, draft picks, and playoffs |
| [Trade legality](trade-legality.md) | Saved roster plans, acceptance, settlement, and receipts |
| [Scheduler operations](operations-scheduler.md) | Cadences, leases, load shedding, retention, and diagnosis |
| [Source monitoring](source-monitoring.md) | Provider identity, projections, corrections, and recovery |
| [Interface design](interface-design.md) | Phone layout, shared controls, typography, and assets |
| [Public agent guide](https://pancakedynasty.vercel.app/agents.md) | Anonymous CLI and API use |
| [Public CLI reference](public-cli.md) | Schemas, privacy rules, and operator reports |

## Detailed contracts

[Trade values](trade-values.md), [trade estimates](trade-estimates.md), and [trade curve](trade-curve.md) separate imported values, frozen quotes, and arithmetic.
[Rankings](dynasty-rankings-restoration.md) documents the distinct Hashtag source.
[Matchup forecasts](matchup-forecasts.md) defines odds, input freshness, and publication.
[Database IO](io-audit.md) defines measurement costs and limits.
[Scoring locks](live-scoring-lock-contention.md) and [pre-tipoff failures](pre-tipoff-trade-offer-fix.md) retain their reproducible regression rules.
[Release notes](release-2.15.md) describe the current release.
The [database runbook](../supabase/RELEASE-DB.md) owns deployment order and incident controls.
