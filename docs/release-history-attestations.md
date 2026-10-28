# Refresh release migration attestations

Use a private local Supabase stack with every repository migration applied.
Reset that stack after any change to an applied migration.
The refresh command updates migration and security catalog attestations from local metadata.
The test helper reads this file and includes every repository migration.
The command preserves the audited production baseline and historical aliases.
It also preserves the recorded pre-migration security catalog.

| Record | Version | Migration count |
| --- | --- | --- |
| Audit baseline | `20261005000003` | 329 |
| Deployed release 1 | `20261029000800` | 564 |
| Release 2.4 candidate | `20261116000500` | 608 |

The approved range contains 279 migrations after the audit baseline.
The deployed release 1 phase has 44 pending migrations.
Release 1 reaches production on 2026-10-27.
Its frontend commit is `1e62824e43044d30007b9601a8a3993c576b6a7e`.

```sh
SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  node scripts/regenerate-release-history-attestations.mjs
```

For a different local database port, also set `PANCAKE_TEST_DB_PORT` to that port.
The command refuses remote database addresses.
It requires the local migration history to match the repository through its head.

Check the result without database access:

```sh
node scripts/regenerate-release-history-attestations.mjs --check
```

CI runs this check.
It fails for missing approvals or changed migration files.
It rejects migration SQL changes made after the local stack applies them.
Run the refresh command again after the final migration changes.

The release soak serves deployed builds for seasons 1–5.
It applies the attested migrations before season 6 starts release builds.
Each later shard verifies the migrated schema before serving release builds.
Earlier seasons run the same six browser scenarios as the deployed-build compatibility checks.
Every season retains required evidence.
Release seasons also retain smoke and performance reports.

The 2026-10-27 refresh uses private mini project `pt4bafablefix`, database port `58722`.
The stack first records the release 1 catalog at 564 migrations.
It then applies all 27 candidate migrations and records the 591-row history and final catalog.
The earlier production catalog remains in `historicalPhases`.
Advance `preMigration` only with a catalog captured at the exact deployed version.
The generator then preserves that catalog during candidate refreshes.

The release 2.4 integration refresh uses private mini project `pt4bafabler24`, database port `59822`.
A fresh installation matches the incremental upgrade across all four generated artifacts.
The history contains 608 migrations and 279 entries after the fixed audit baseline.
The recorded pre-migration catalog remains at 564 migrations.
