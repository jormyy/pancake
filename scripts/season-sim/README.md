# Historical season simulator

The simulator uses real local dispatch, handlers, database rules, and authenticated actions.
The [simulator contract](../../docs/season-simulator.md) owns source classes, checks, and acceptance limits.

## Targets and prerequisites

This harness is tied to a dedicated external installation.
`scripts/season-sim/common.mjs` sets its root under the user's home directory.
Setup requires the repo child directory, a tools child directory containing the official supabase-go executable, and the assigned Docker socket.
The installer checks the exact checkout and socket before changes.
These external prerequisites are not repository files. Ordinary local setup does not create them.

| Service | Required local target |
| --- | --- |
| Supabase project | `pt0493sim` |
| API and Auth | HTTP loopback port 56221 |
| PostgreSQL | Loopback port 56222 |
| Fixture origin | HTTP loopback port 56280 |
| Deno router | HTTP loopback port 56281 |

The guarded SQL helper permits only the project's database container.
`local-stack.mjs` disables cron launch before migration and unschedules jobs.
It changes Supabase configuration only in the external simulator copy.
`runtime.mjs` reads that stack's local keys and creates an internal token in memory.
Never copy repository or profile environment files into this setup.
Keep fixtures, state, keys, and evidence outside the repo child directory.

## Collection and audit

Collection needs network access. Audit uses the verified local fixture store.

```sh
npm run e2e:season-sim -- --help
npm run e2e:season-sim -- --collect
npm run e2e:season-sim -- --collect --days 2 --games 20
npm run e2e:season-sim -- --audit
node scripts/season-sim/audit-identities.mjs
node scripts/season-sim/plan-audit.mjs
```

The manifest records source URL, retrieval time, response status, bytes, and SHA-256.
Reads verify decompressed bytes. Raw final boxes remain unchanged.
`scripts/season-sim/known-discrepancies.json` pins exact live counting-stat exceptions.
`scripts/season-sim/known-identities.json` pins the reviewed provider identity correction.
Neither file waives final equality.

## Fresh replay

Preserve failed evidence before resetting synthetic database state.
Run setup only from the assigned external checkout.
The stop command below removes only the owned project's synthetic database volume.

```sh
../tools/supabase-go stop --project-id pt0493sim --no-backup
node --input-type=module -e 'import { setupStack } from "./scripts/season-sim/local-stack.mjs"; await setupStack()'
npm run e2e:season-sim -- --replay
node scripts/season-sim/report.mjs
```

The default replay covers all configured season dates, playoff grace, rollover, and a rookie draft.
It creates synthetic users and completes the opening auction.
Daily phases exercise lineups, lock rejection, waivers, adds/drops, IR, taxi, and trades.
Faults run inside the timeline. Next-day and final repeat audits verify recovery and idempotence.
The generated final report establishes completion; collection success does not.

## Diagnostics

```sh
npm run e2e:season-sim -- --replay --start 2025-10-27 --days 1
npm run e2e:season-sim -- --replay --days 9
npm run e2e:season-sim -- --lifecycle --start 2025-10-28
node scripts/season-sim/fault-run.mjs 2025-10-26
node scripts/season-sim/verify.mjs
node scripts/season-sim/verify.mjs --live-recipe
node scripts/season-sim/verify.mjs --clock-roundtrip
node --test scripts/season-sim/*.test.mjs
```

Short, resumed, and standalone probes do not prove fresh full-season acceptance.
Never reset or replace source files during an active replay.

## Cleanup

Restore native clocks through the guarded SQL helper, then stop only the owned stack:

```sh
../tools/psql postgresql://postgres@127.0.0.1:56222/postgres -v ON_ERROR_STOP=1 -f scripts/season-sim/restore-clock.sql
../tools/supabase-go stop --project-id pt0493sim
```

The tools directory must contain the guarded `scripts/season-sim/psql.mjs` wrapper as psql.
Keep reports outside tracked docs and omit generated keys from evidence.
