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
| Recorded production phase | `20261020000007` | 431 |
| Approved candidate | `20261029000800` | 564 |

The approved range contains 235 migrations after the audit baseline.
The recorded production phase has 133 pending migrations.

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
