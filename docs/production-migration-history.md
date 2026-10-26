# Production migration history

The release preflight accepts audited historical migration names for production project `ceeytbfmwsnzalxlkalc`. This record defines the attested range, validation steps, and forward recovery requirements.

## Attested history

[`release-history-attestations.json`](../tests/e2e/release-history-attestations.json) owns approved versions, names, fingerprints, classifications, convergence bodies, and the migration range.
The attestation's `baselineVersion` and `baselineCount` define the historical audit anchor.
Its `approvedMigrations` array defines the approved range and its size.
[`db-security-catalog-attestations.json`](../tests/e2e/db-security-catalog-attestations.json) defines the recorded pre-migration phase in `preMigration`.
The post-migration count equals `baselineCount` plus the length of `approvedMigrations`.
The pending count equals that total minus `preMigration.count`.
A partial upgrade plans only the remaining approved suffix.
Each applied range member must match its statement count and stored-SQL fingerprint.

The preflight accepts the historical names attested for commit `c083075fe75976852fa2307c54d8fc7b3b33e9a6`.
Stored statements match that commit's parent.
Most match current parsed SQL apart from header comments.
The following contain temporary helper-name changes:

| Version | Historical helper names | Repository helper names |
| --- | --- | --- |
| `20260627000011` | Two lineup helpers use `_unchecked_cycle18` | `_unchecked_legacy` |
| `20260627000017` | Update helper uses `_uncapped_cycle23`; calls use cycle18 names | `_unchecked_legacy` |
| `20260627000025` | Cleanup renames cycle18/cycle23 helpers | Cleanup renames legacy helpers |

Both sequences converge to the same three `_unchecked` helpers.
The preflight checks seven live function bodies, signatures, settings, and effective grants.
It rejects remaining old helpers or calls to old names.

Approved replacements change the expected convergence body only after their migration appears in history:

| Migration | Replaced functions |
| --- | --- |
| `20261011000002` | `auto_set_lineup_atomic_unchecked` |
| `20261011000010` | `auto_set_lineup_atomic`, `set_player_slot_moves_atomic` |
| `20261011000012` | `update_lineup_slots_atomic_unchecked` |
| `20261018000012` | `auto_set_lineup_atomic`, `set_player_slot_moves_atomic` |
| `20261029000700` | `auto_set_lineup_atomic_unchecked` |

Each `convergenceRedefinitions` entry must name an approved migration containing the recorded body in dollar-quoted SQL.
An early replacement or a late baseline body fails.

Refresh the range and post-migration catalog with the [local refresh command](release-history-attestations.md).
The command preserves the recorded production catalog.

## Fingerprints and evidence

Repository fingerprints use SHA-256 over file bytes.
Stored-SQL fingerprints hash each statement, concatenate the lowercase SHA-256 hex strings in order, then hash that concatenation.
Statement counts are checked separately.
Production fingerprint checks perform no SQL normalization or identifier substitution.

Compare a fresh install with an ordered baseline-to-candidate upgrade before extending attestations.
Include an intermediate upgrade state to check mixed convergence bodies.
Compare recorded statement counts and fingerprints, not only the final schema.
Local evidence does not replace the current production history check.
Unrelated applied rows receive ordered version/name checks; this audit does not cover their SQL.

The historical audit anchor stays fixed when the recorded production phase advances.
Earlier approved migrations retain their source and stored-SQL fingerprint checks.
A later schema release must extend the reviewed range and update changed convergence expectations.
The catalog separately pins the exact recorded production phase and its pending suffix.

## Release preflight

[`release-schema-history.sql`](../tests/e2e/release-schema-history.sql) reads metadata inside a READ ONLY transaction.
It returns fingerprints without stored SQL, function bodies, credentials, or application rows.
The workflow validates the target and linked project ref before querying, then passes that ref to the planner.
This path supports the workflow's pinned Supabase CLI 2.109.1.

The generic planner requires exact names.
The production entry point accepts only attested aliases and exact SQL, preserving original labels in its result.
Missing, duplicate, reordered, foreign, or unapproved pending versions fail.
Changed attested SQL, source files, helper bodies, or grants also fail.

The successful release soak exports a SHA-256 digest of its attested plan.
Before index preparation, the production job checks the source commit, target, linked ref, history, fingerprints, convergence, and plan digest.
It repeats those checks immediately before `supabase db push`.
A changed applied prefix or pending suffix requires a new soak.
The workflow retains both read-only snapshots and plans as artifacts.

Workflow concurrency serializes its deployments but holds no database lock across the CLI query and push.
An authorized manual application must exclude concurrent migration writers and repeat the immediate checks against the successful soak's plan digest.
Supabase's version planner and CLI dry run do not replace these gates.
Read-only preflight does not apply migrations or authorize frontend or Edge deployment.
[Verification](verification.md#release-gates) owns the coordinated release sequence.

## Scoring cache recovery

The cache migrations replace a derived materialized cache and its public security-invoker view.
Apply `20261006000001` after the league-season migration.
Check view readers, lock contention, data size, dependencies, and rebuild time before application.
Prepare the prior definition as a forward recovery migration.
A transaction prevents partial replacement; frontend rollback retains the additive schema.

| Migration | Behavior | Forward recovery source |
| --- | --- | --- |
| `20261006000001` | Shares scoring aggregation across equal league settings | Previous reviewed cache/view definition |
| `20261007000001` | Extracts JSON coefficient text once per league; preserves conditional numeric casts | `20261006000001_share_scoring_cache_aggregation.sql` |
| `20261008000001` | Converts eleven ordinary coefficients once per league; keeps bonus casts conditional | `20261007000001_extract_scoring_cache_coefficients.sql` |

The coefficient migrations preserve per-game rounding, DNP filtering, settings equality, output columns, grants, and refresh scheduling.
The numeric migration requires a validated `scoring_settings_schema` constraint.
Missing coefficients retain the original zero fallback.

Replacement uses a three-second lock timeout and a 120-second statement timeout.
Timeout or interruption rolls back the transaction. Do not remove limits to force application.
Recovery appends a forward migration with the prior definition and the same transaction limits.
Rebuild from current source data; preserve the public view and access controls.
Do not delete migration history or restore stale materialized rows.
Verify definitions, indexes, grants, RLS, and canonical score equality after recovery.
Scoring tests compare refreshed rows with `v_fantasy_points`, including changed settings, corrections, DNP, deletion, and game eligibility.
Local recovery evidence does not establish production lock availability or device performance.

## Candidate migrations

The candidate adds the approved suffix after the security attestation's `preMigration.version`.
The release-history attestation defines its final version and total count.
These additions cover scoring, identity, drafts, notifications, roster rules, and taxi acquisitions.
They preserve published migration files.
The approved release range includes every file recorded in `approvedMigrations` and its baseline.
An ordered local upgrade must match a fresh installation at the approved candidate version.
Preserve earlier source fingerprints and review each addition to the attested range.
The release must pass the soak, compatibility, and immediate production preflight gates.
The [database release steps](../supabase/RELEASE-DB.md#release-order-for-this-release) list this release's unpublished migrations.

Migrations `20261020000001` through `20261020000007` add Sleeper projections, update readers and scheduling, and bound operational cleanup.
They preserve the historical aliases and belong to the reviewed 431-row production phase.
Any migration beyond the attested range requires another reviewed contract update.
The canonical function catalog records current completion and cleanup helpers separately.

| Migration | Change |
| --- | --- |
| `20261020000001` | Adds the Sleeper player-game store, completion RPC, and projection period index |
| `20261020000002` | Adds Sleeper-first readers, projection dispatch, fingerprints, and resource hints |
| `20261020000003` | Bounds operational retention and projection cleanup; compacts FantasyPros snapshots |
| `20261020000004` | Keeps game-day recovery independent of Monday; fixes compaction trigger permissions |
| `20261020000005` | Replaces absent upcoming snapshot games; excludes old-team lines; expires reconciled worker crashes |
| `20261020000006` | Preserves filtered source rows and prior-team games; returns projection freshness |
| `20261020000007` | Guards snapshot replacement below 70% upcoming coverage; retains accepted updates and records failure |

Apply the schema before deploying `sync-sleeper-projections`.
The scheduler retains dispatch claims and invocation reconciliation.
Frontend rollback retains these database changes.
[Source monitoring](source-monitoring.md) owns projection and retention behavior.
[Verification](verification.md#sleeper-projections-and-weekly-cleanup) owns the focused checks.

The approved candidate now ends at `20261029000800`, with 564 migrations.
The audit baseline stays at `20261005000003`, with 329 migrations.
The recorded production phase stays at `20261020000007`, with 431 migrations.

| Migration | Change |
| --- | --- |
| `20261029000100` | Requires scheduled FAAB claims for every pickup |
| `20261029000200` | Allows eligible IR and taxi players on the trade block |
| `20261029000300` | Stores trade roster moves and reserves settlement capacity |
| `20261029000400` | Stores trade estimates with their exact terms and inputs |
| `20261029000500` | Stores matchup forecasts and schedules their updates |
| `20261029000600` | Revalues historical trades with current inputs |
| `20261029000700` | Allows scheduled lineup updates beside live game locks |
| `20261029000800` | Uses a consistent lock order when saving matchup forecasts |

Local checks on 2026-10-26 compare a fresh installation with an ordered upgrade from the audit baseline.
Both paths have equal migration names, statement counts, stored-SQL fingerprints, helper definitions, and security catalogs.
An intermediate state at `20261011000010` matches its expected mix of helper definitions.
The upgrade from that state also matches the fresh installation through `20261029000800`.
