# Database readiness catalog

The catalog gate validates the database phase explicitly. It does not apply migrations or infer success from missing objects.

| Phase | Required applied history | Required cron wrapper |
| --- | --- | --- |
| `pre-migration` | Exactly 320 migrations through `20260828000002`; the approved five remain pending | `invoke_edge_function_at_et_time(text, integer, integer)` |
| `post-migration` | Exactly 325 migrations through `20260921000002`; none pending | `invoke_edge_function_at_et_time(text, integer, integer, timestamptz)` |

Partial upgrades, reordered history, unknown aliases, changed approved SQL, unexpected overloads and wrong project links fail. The production history planner retains its audited historical-alias checks. Local databases require canonical migration names and no production link.

Both phases require the actual drop-player guard chain:

`drop_player_atomic` → the enabled `sync_roster_linked_state` roster trigger → `private.sync_roster_linked_state` → `private.clear_future_unlocked_lineups` → `private.lineup_game_started`.

The gate pins function signatures, defaults, raw body SHA-256, owners, search paths and execute grants. It also pins roster trigger definitions and enabled states, waiver policies, required RLS boundaries and valid indexes. The started-game predicate remains in the private helper. Searching the public RPC for obsolete inline text cannot prove this protection.

The pre-migration contract validates the existing cron wrappers and guards positively. The post-migration contract additionally requires the reviewed scheduling objects, RLS and indexes. Missing candidate objects never pass the post-migration gate. Metadata verification complements the retained roster and lineup behavioral tests; it does not replace them.

## Commands

Use one target per invocation. Linked checks require both `SUPABASE_PROJECT_REF` and the CLI project link to match the attested production project.

```sh
npm run security:db-catalog -- --linked --phase=pre-migration
npm run security:db-catalog -- --linked --phase=post-migration
npm run security:db-catalog -- --local --phase=post-migration
```

These commands include the existing weak-password signup probe. For metadata-only inspection, append `--catalog-only`. That mode uses read-only SQL and writes `tests/db-security-catalog-readonly-report.md`. It does not certify signup or full readiness. The production workflow never uses this option.

Local catalog reads require `psql`. They use the CLI-reported loopback database URL and preserve the same read-only transactions as linked queries.

The candidate/current-backend deployment pairing requests `pre-migration`. All later pairings request `post-migration`, including frontend rollback: additive database migrations remain applied. Reusable workflow calls require the phase input. Standalone readiness dispatches select `post-migration`. The phase comes from the input, because a reusable workflow inherits its caller's event context.

## Attestation maintenance

`tests/e2e/db-security-catalog-attestations.json` contains the reviewed contracts. The initial pre-migration snapshot matches both production metadata and a fresh local baseline. The candidate snapshot comes from applying only the approved five migrations locally. No production rows or credentials enter the manifest.

Pinned source migration hashes bind the function contracts to repository SQL. A regression test also proves every attested body hash occurs in those pinned sources. Future schema changes require reviewed phase and source-pin updates with fresh database evidence; regenerating pins from an unexplained live difference is not an accepted update procedure.

This gate does not waive projection freshness, artifact verification, compatibility, full-season acceptance or other release checks. A catalog pass alone does not authorize a release.
