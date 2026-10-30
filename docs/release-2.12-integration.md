# Release 2.12 integration

The supplied production head is `20261214003900` at `952580ce`.
The integrated database has 719 migrations through `20261214005302`.
No production service, deployment, push, PR, or CI run is part of this work.

Repeat this checklist after later lanes merge:

- Merge finished lanes without changing product behavior.
- Refresh conflicting attestations with [the documented generator](release-history-attestations.md). Preserve the audit anchor and recorded production catalog.
- Compare an ordered upgrade from `20261214003900` with a fresh reset. Compare both attestations, the function catalog, database types, and schema.
- Remove raw samples, evidence dumps, receipts, and generated result tables. Keep fixtures read by tests and harnesses used by rerun recipes. Record every removed path and byte count.
- Keep one short summary per lane with its method, before/after table, and rerun commands.
- Remove duplicate or unreferenced verification scripts only after naming the retained coverage. Keep Lineup cache, roster, trade lock, auto-set, and reproduced-bug regressions.
- Run Knip. Remove unused code and dependencies, and remove entries for deleted scripts.
- Consolidate database rollout notes under Release 2.12. Remove references to deleted scripts.
- Commit artifacts, test pruning, dead code, and docs separately with `[skip ci]`.
- Run both typechecks, lint, Knip, full Vitest, SQL source/catalog checks, database type and attestation checks, and the lane SQL recipes on the final head.
- Stop only the assigned private stack. Leave shipping to the orchestrator.

This integration uses Docker Desktop context `desktop-linux`, project `pt4bafableint`, ports `650xx`.
The temporary stack directory is `/tmp/fable-int/stack`.
Repository config stays unchanged. Cron is disabled and `pg_net.batch_size=0` prevents delivery.
Use Node 22 and PostgreSQL client 16 or newer.

Initial verification before cleanup:

| Check | Result |
| --- | --- |
| Application and test typechecks; lint; canonical SQL sources | Pass |
| Knip | Unlisted `ps` binary in the unused keeper-guard script |
| Full Vitest | 4,926 pass, 48 skip, 1 release-order documentation failure |
| Ordered upgrade and fresh reset | All 719 migrations; four generated artifacts and schema match byte for byte |
| Function catalog and regenerated database types | Pass; removed one expired partition type through the generator |
| Statistics catalog controls | All three inline-maintenance mutations rejected; original catalog restored |

The initial 80-recipe sweep has 78 passes and two baseline limitations.
`statistics-maintenance.sql` fails the physical-table analyze-policy assertion on both main's 711-migration schema and the candidate.
`player_game_stats` lacks those reloptions after the earlier unpartition migration. No product fix is included.
`forecast-inputs-bound-regression.sql` requires restored matchup IDs; it reports no rows on both empty schemas.
The PostgreSQL 14 client rejected three `\getenv` recipes. All three pass with client 16.
The focused statistics freshness recipe passes eleven assertions. Statistics catalog mutation controls pass.
The Taxi auction recipe passes on both empty schemas here. The supplied earlier main reproduction remains a pre-existing bug record.

Final verification runs the listed checks once on the cleanup head.
Logs and machine-readable results stay outside Git under `/tmp/fable-int`.
The final handoff reports their actual pass/fail counts.
The supplied Taxi auction failure is pre-existing on main `952580ce`; retain its regression.
