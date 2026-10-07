# Database readiness catalog

The catalog gate validates the database phase explicitly. It does not apply migrations or infer success from missing objects.

| Phase | Required applied history | Required cron wrapper |
| --- | --- | --- |
| `pre-migration` | Exactly 328 migrations through `20261005000002`; both approved migrations remain pending | `invoke_edge_function_at_et_time(text, integer, integer, timestamptz)` |
| `post-migration` | Exactly 330 migrations through `20261006000001`; none pending | `invoke_edge_function_at_et_time(text, integer, integer, timestamptz)` |

Partial upgrades, reordered history, unknown aliases, changed approved SQL, unexpected overloads and wrong project links fail. The production history planner retains its audited historical-alias checks. Local databases require canonical migration names and no production link.

Both phases require the actual drop-player guard chain:

`drop_player_atomic` → the enabled `sync_roster_linked_state` roster trigger → `private.sync_roster_linked_state` → `private.clear_future_unlocked_lineups` → `private.lineup_game_started`.

The gate pins function signatures, defaults, raw body SHA-256, owners, search paths and execute grants. It also pins roster trigger definitions and enabled states, waiver policies, required RLS boundaries and valid indexes. The started-game predicate remains in the private helper. Searching the public RPC for obsolete inline text cannot prove this protection.

The pre-migration contract validates the existing cron wrappers and guards positively. The post-migration contract additionally requires the reviewed scheduling objects, RLS and indexes. Missing candidate objects never pass the post-migration gate. Metadata verification complements the retained roster and lineup behavioral tests; it does not replace them.

The integrated range also includes `20261006000001`, which replaces the derived
scoring cache without changing the objects pinned here. An ordered local CLI
application from 328 to 330 migrations confirms both phase catalogs exactly.
The scoring migration's source and stored SQL hashes are pinned in the release
history attestation. This catalog does not measure production lock or rebuild cost.

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

`tests/e2e/db-security-catalog-attestations.json` contains the reviewed contracts. The candidate snapshot comes from applying the first five approved migrations of the earlier range locally; the `web_push_subscriptions` table and index entries were captured read-only from production after `20260926000001` was applied. On 2026-10-05 the baseline moved from `20260828000002` (320) to `20260926000001` (326): production had applied those six migrations outside this workflow, with stored SQL matching their attested fingerprints. The pre-migration contract is therefore the converged schema; read-only production metadata and a fresh local install reset to `20260926000001` both match it. `20261005000001` and `20261005000002` add only cron jobs and two service_role-only cron gate functions outside the attested catalog, so both phases share one object set and differ only in applied history. On 2026-10-06 the baseline moved to `20261005000002` (328) after production applied those two migrations; their stored SQL matched the attested fingerprints, and read-only production metadata matched the former post-migration contract, which became the pre-migration contract. `20261005000003` changes `invoke_season_boundary_if_due`, the only attested object it touches, so the post-migration contract pins that body from a fresh local install, and the migration joins the source pins. No production rows or credentials enter the manifest.

Pinned source migration hashes bind the function contracts to repository SQL. A regression test also proves every attested body hash occurs in those pinned sources. Future schema changes require reviewed phase and source-pin updates with fresh database evidence; regenerating pins from an unexplained live difference is not an accepted update procedure.

This gate does not waive projection freshness, artifact verification, compatibility, full-season acceptance or other release checks. A catalog pass alone does not authorize a release.
