# Release 2.9 integration

Release 2.9 combines `climb/l3d-slow-screens` and `work/pick-horizon-5` on release 2.8, `628c7def`.
Merge commit `2de07179` completes the pending merge.
The migration order is `20261214000500`, `20261214000501`, then `20261214000700`.

The only shared behavior change is `private.trade_revaluation_input_version`.
Its canonical source and final migration retain PL/pgSQL, `force_generic_plan`, and `league.future_pick_years`.
The installed fingerprint is stable and changes when the horizon changes.
Restoring the horizon restores the fingerprint.
Other shared files are `knip.json`, release notes, the function catalog, database types, and the two attestations.
Their changes combine without another semantic overlap. No additional code fix was needed.

The private mini project `pt4bafabler29` uses only ports 627xx.
The supplied production-shaped backup was restored before applying the release migrations.
The backfill recipe passed before the final migration and verified its own second run.
The repository generators regenerated both attestations and the function catalog.
Repeated generation is identical. All 689 migration fingerprints and the live security contract pass.

Verification on Node 22:

- `npx vitest run --maxWorkers=1`: 4,670 pass, 48 skip, zero failures.
- `node --test scripts/season-sim/*.test.mjs`: 346 pass, zero failures.
- `npm run check:quality`: pass, including lint and all configured type checks.
- Sixteen SQL recipes pass, including backfill, both slow-screen recipes, pick windows, future-pick settings and cleanup, trade revaluation, screen parity, and the three-season simulation.
- Screen and dense trade JSON comparisons: 470 pass across live-game and off-day fixtures. Four corrupted-response controls reject the changed response.
- Restored trade inputs: six byte comparisons pass across three open trades and two scoring settings.
- Canonical function sources, live function catalog, and generated database types pass.

Recipes use the lane's fixture preparation, `ANALYZE`, and local `supabase_admin` role.
Temporary harness adapters select the assigned project and ports without changing repository scripts.
Comparisons hold the pick-horizon rule constant; the restored trade-input comparison uses the existing three-year contract.
Cron stayed disabled and database HTTP blocked external destinations.
The private stack is stopped, its configuration is restored, and transferred backups are deleted.
No production service, email, push notification, deployment, push, PR, or CI run was used.
