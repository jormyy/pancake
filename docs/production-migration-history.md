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
During an authorized deployment, preflight checks seven live function bodies, signatures, settings, and effective grants.
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

The release 2.4 candidate ends at `20261116000500`, with 608 migrations.
The audit baseline stays at `20261005000003`, with 329 migrations.
Release 1 reaches production on 2026-10-27 at `20261029000800`, with 564 migrations.
Its frontend commit is `1e62824e43044d30007b9601a8a3993c576b6a7e`.
The pre-migration catalog now records that release.
The earlier 431-row catalog remains historical evidence.

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

## Release 2.4 candidate

Release 2.4 adds 44 migrations after the recorded release 1 head.
The audited range contains 279 migrations after the fixed 329-row baseline.

| Migration | Change |
| --- | --- |
| `20261101000100` | Adds stored screen results and their refresh queue. |
| `20261101000200` | Adds member-scoped screen reads and refresh functions. |
| `20261102000100` | Adds league versions and one change event per committed league write. |
| `20261103000100` | Stores request receipts to make write retries safe. |
| `20261103000200` | Expires request receipts during history cleanup. |
| `20261103000300` | Saves client settings through request receipts. |
| `20261104000100` | Replaces separate job schedules with a leased work queue and dispatcher. |
| `20261105000100` | Stores sampled screen timing beacons and private summaries. |
| `20261106000100` | Stores private team timeline events. |
| `20261106000200` | Records claims, trades, lineups and score events. |
| `20261106000300` | Records lineup slot setting changes. |
| `20261107000100` | Preserves locked historical lineups. |
| `20261107000101` | Restores retained lineup history. |
| `20261107000102` | Protects closed lineup dates. |
| `20261107000200` | Adds linear rookie draft order. |
| `20261107000201` | Keeps rookie mock draft order consistent. |
| `20261107000300` | Stores league time zones. |
| `20261107000400` | Adds player birthdates to screen views. |
| `20261107000500` | Adds player injury details. |
| `20261107000501` | Includes injury details in player search. |
| `20261107000600` | Adds player mentions to league activity. |
| `20261109000100` | Runs daily bounded retention and records cleanup results. |
| `20261109000900` | Derives provider history windows from policy and preserves career eligibility. |
| `20261110000100` | Adds complete server views for client screens. |
| `20261111000100` | Publishes screen refresh versions. |
| `20261112000100` | Gives tied rookie records the higher points-per-game pick first. |
| `20261112000200` | Records every trade transition with player identity and preserves feed privacy. |
| `20261113000100` | Bounds notification checks before stale and preference evaluation. |
| `20261113000200` | Gives workers five-minute leases and avoids renewal lock waits. |
| `20261114000100` | Bounds retention, refresh batches, active workers and database waits. |
| `20261114000200` | Adds the operator pause control before SQL dispatch claims. |
| `20261114000300` | Limits dispatch transactions and avoids duplicate queue insertion waits. |
| `20261114000400` | Preserves birthdate bounds through the supported transaction clock. |
| `20261115000100` | Removes idle hint worker writes, bounds cron history, and tunes owned hot tables. |
| `20261115000200` | Skips equal screen content and separates trade publication freshness. |
| `20261115000300` | Coalesces repeated league hint scopes and publication topics. |
| `20261115000400` | Skips identical score and stat progress writes. |
| `20261115000500` | Bounds player history reads and preserves forecast scoring. |
| `20261115000600` | Stores forecast inputs and updates season projections with stat changes. |
| `20261116000100` | Uses league dates on Home and includes roster birthdates. |
| `20261116000200` | Rejects conflicting player identities and repairs impossible game teams. |
| `20261116000300` | Queues trade estimates after the offer commits. |
| `20261116000400` | Rejects repeated pending offers and bounds trade write locks. |
| `20261116000500` | Queues trade events and screen updates after trade writes. |

The recorded pre-migration security catalog stays pinned to release 1 at 564 migrations.
The private mini applies the integrated migrations, then rebuilds all 608 migrations from empty.
Both paths produce identical migration attestations, security attestations, function catalogs, and database types.
The final migration history contains 608 rows through `20261116000500`.
The shared attestation supplies the soak and immediate preflight ranges.

The latest supplied operator report places production at `20261113000200`.
This documentation review makes no live production query.
The recorded pre-migration catalog still describes release 1 at `20261029000800`.
These are different checkpoints.
The planner validates the actual applied prefix before choosing the pending suffix.

Release 2.4 keeps IO migrations at `20261115000100`–`20261115000400`.
Forecast migrations use `20261115000500`–`20261115000600`.
UI migrations keep `20261116000100`–`20261116000200`.
Trade migrations use `20261116000300`–`20261116000500`.
The ordered history has no duplicate versions.
The candidate adds 12 migrations after `origin/main` at `6ad9b65e` and 11 after integration base `c3209ddc`.
Integration uses private mini project `pt4bafabler24` and ports `598xx`.
It performs no production access.

## Release 2.5 candidate

Release 2.5 starts from release 2.4 source `d267428f` at 608 migrations.
It adds 13 migrations and ends at `20261123000100`, for 621 total migrations.
The fixed 329-migration audit anchor leaves 292 approved migrations.
The recorded 564-migration release 1 security baseline leaves a 57-migration candidate suffix.
The release planner derives the actual pending suffix from verified applied history.
The older supplied operator checkpoint does not establish the current production head.
This integration makes no production request.

| Migration | Change |
| --- | --- |
| `20261117000100_player_link_identity_index.sql` | Indexes player links for identity resolution. |
| `20261117000200_stat_player_resolution.sql` | Resolves stat identities without locking player rows. |
| `20261118000100_public_cli.sql` | Adds share tokens, public reads, limits, and audit retention. |
| `20261118000200_public_matchup_state.sql` | Preserves void flags and multiweek matchup ranges in public reads. |
| `20261118000300_public_stats_seasons.sql` | Reads player statistics from seasons before league creation. |
| `20261120000100_onenumber_trade_values.sql` | Adds value storage, review matching, publication, and daily work. |
| `20261120000200_trade_value_readers.sql` | Supplies stored values to player profiles and trade details. |
| `20261120000300_trade_value_cache_refresh.sql` | Refreshes league readers after value publication or review. |
| `20261121000001_league_midnight_waivers.sql` | Processes scheduled claims at each league midnight. |
| `20261121000004_reschedule_waivers_timezone.sql` | Moves pending claims and drop holds when league time changes. |
| `20261121000005_league_local_view_day.sql` | Uses the league date in shared screen context. |
| `20261122000100_player_views.sql` | Splits player sections and improves dynasty sorting. |
| `20261123000100_release25_player_values_and_schedule.sql` | Preserves league-midnight waivers, daily values, and both profile formats. |

The incoming branches have no timestamp collisions; their migration versions stay unchanged.
The final migration combines daily value scheduling with league-midnight waiver work.
It also preserves stored values in compact and legacy player profiles.
The function source checks detect both overwritten definitions before that repair.
The combined behavior test fails before the repair and passes afterward.

Private project `pt4bafabler25` uses ports `582xx` with cron launch disabled.
The incremental upgrade and fresh 621-migration installation produce identical generated artifacts.
Those artifacts are both attestations, `supabase/sql/function-catalog.json`, and `types/database.ts`.
The generator preserves the recorded production baseline and historical aliases.
[Release contract](../supabase/RELEASE-DB.md) owns deployment order and the complete Edge function list.
[Integration evidence](release-2.5-integration.md) owns executed counts and changed files.


## Release 2.6 candidate

Release 2.6 starts from `78c01b8c` and the supplied head `20261123000100` at 621 migrations.
It adds four migrations and reaches `20261124000400`, for 625 total migrations.
The fixed 329-migration audit anchor leaves 296 approved migrations.
The recorded security baseline stays at 564 migrations through `20261029000800`.
Its candidate suffix contains 61 migrations; rollout verifies the actual applied prefix.

| Migration | Change |
| --- | --- |
| `20261124000100_trade_value_fetch_retries.sql` | Releases failed daily claims and schedules bounded retries. |
| `20261124000200_trade_estimate_reanalysis.sql` | Preserves original quotes and adds versioned trade re-analysis. |
| `20261124000300_trade_estimate_pick_inputs.sql` | Shares pick bands and bounds replacement-player inputs. |
| `20261124000400_pick_predictions_and_ranking_cleanup.sql` | Stores pick predictions, chains refreshes, and removes ranking work. |

All four timestamps are distinct and remain unchanged.
The final scheduler retains daily values and league-local midnight waivers.
Successful values queue pick predictions before versioned trade re-analysis.
The retry RPC retains its claim-release and 30-minute retry rules beside that chain.
Private project `pt4bafabler26` uses ports `586xx`.
Both attestations, the function catalog, and database types come from that private database.
An ordered upgrade and fresh installation produce identical bytes for all four artifacts.
The audit anchor, historical aliases, and recorded production catalog remain unchanged.
No production metadata or application data is read during this integration.
[Release contract](../supabase/RELEASE-DB.md) owns rollout order and all five changed Edge functions.
[Integration evidence](release-2.6-integration.md) owns executed counts and changed files.
