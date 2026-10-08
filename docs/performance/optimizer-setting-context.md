# Optimizer setting writes

`20261008000002_optimizer_setting_context_writes.sql` enables the existing owner toggle.
Authenticated clients can insert or update only `league_id`, `league_season_id`, `member_id`, `enabled`, and `enabled_at`.
Existing owner RLS still requires the real authenticated user's member ID. It grants no owner DELETE or audit-field writes.

Composite foreign keys require both the member and season to belong to the selected league. They apply to inserts, updates, and service-role writes. A valid complete tuple move between the same user's leagues remains subject to owner RLS. Separate single-column foreign keys and their cascades remain.

The migration locks all three relations before checking existing rows. It refuses inconsistent tuples without changing or removing them. Unique parent indexes support the composite keys. This adds two indexes, foreign-key checks, and write locks during installation. Local fixture results do not establish production installation time or size.

Before production application, confirm the project and predecessor migrations, inspect actual constraint/policy/grant hashes, relation sizes, pending locks, and inconsistent rows. Apply with the normal transactional migration runner. The three-second lock timeout and thirty-second statement timeout abort unavailable or oversized installation attempts. A refusal requires separate diagnosis; do not delete or rewrite existing records to force application.

For recovery, revoke the five INSERT/UPDATE column privileges first, then drop `lineup_optimizer_settings_member_league_fkey` and `lineup_optimizer_settings_season_league_fkey`, followed by `league_members_id_league_key` and `league_seasons_id_league_key`, in one bounded transaction. Leave rows, original foreign keys, RLS, table privileges, and triggers intact. Recheck for inconsistent tuples before reapplying. Normal migration history must reflect the deployment or recovery; do not edit applied migration files.

Run `tests/db/optimizer-setting-context.sql` against an isolated migrated database. The test rolls back its fixtures and verifies owner writes, rejected tuple changes, foreign ownership, restricted fields, service integrity, and membership cascade. Browser acceptance also checks the unchanged Auto-Set controls against real Auth/PostgREST and the optimizer handler. This change does not address offline Lineup restoration or the separate midnight counterexample.
