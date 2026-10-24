# Verification

Use these recipes to verify changes on isolated local fixtures and prepare release evidence. Each check states its setup and acceptance limits.

## Local stack

Use an isolated checkout, project ID, and port block for database or browser fixtures.
Do not copy private environment files between checkouts.
Use Node 22, installed dependencies, Docker, the Supabase CLI, and the browsers required by the selected check.

1. Set the isolated project ID and all ports in `supabase/config.toml`.
2. Start that stack with `supabase start`.
3. Read its own public URL and local keys with `supabase status -o env`.
4. Populate `.env` from `.env.example` using those local values.
5. Serve functions with `supabase functions serve --env-file .env`.
6. Run `npm run e2e:seed` before checks that need the shared browser fixture.
7. Run `npm run build:web:release` and serve the generated dist directory.

```sh
node tests/e2e/static-web-server.mjs --root=dist --port=8082
```

Set `E2E_FRONTEND_URL` to that server before browser checks.
The seed removes the previous seed's league and users. Use only disposable local data.
Internal jobs require `PANCAKE_EDGE_INTERNAL_TOKEN` to match the database dispatch token.
The database dispatcher reads `app.edge_internal_token` or the Vault fallback.
Its Supabase origin comes from `app.supabase_url` or the corresponding Vault fallback.
The CI database setup in `.github/workflows/test.yml` shows the local dispatch wiring.
Do not apply that wiring to a hosted project.

The [layout setup](../tests/e2e/layout-stability-README.md) generates local-only environment and seed files outside the checkout.
The [simulator](../scripts/season-sim/README.md) and [profiler](../scripts/bench/README.md) require their own fixed targets.

## Checks

| Check | Command | Prerequisite |
| --- | --- | --- |
| Quality | `npm run check:quality` | Installed dependencies |
| Dependency advisories | `npm run security:audit` | Registry access |
| Edge runtime | `npm run check:edge-functions` | Deno and its imports |
| Database type parity | `npm run check:database-types` | Local migrated database |
| Database function catalog | `npm run check:db-function-catalog` | Local migrated database |
| Focused app tests | `npx vitest run <test-file>` | Select tests for the changed behavior |
| Database behavior | `npm run test:db` | Isolated stack and local database environment |
| Browser clients | `npm run e2e:web-targets` | Seeded release server and functions |
| Layout | `npm run e2e:layout-stability -- --help` | [Layout setup](../tests/e2e/layout-stability-README.md) |
| Budgets | `npm run perf:budget` | Saved measurement reports for report enforcement |
| Autonomous seasons | `npm run e2e:perpetual` | Local stack; see [browser guide](../tests/e2e/README.md) |
| Release soak | `npm run e2e:soak:release` | Release workflow setup and migration baseline |

Run focused tests while iterating. Reserve full suites and heavy replay for the release checks.
A skipped check or missing metric is not a pass.
Use negative controls to prove that a gate detects the protected failure.

## Rule coverage

| Behavior | Focused database commands |
| --- | --- |
| Taxi eligibility and tenure | `npm run test:db:dynasty-rules` |
| Atomic trade plans | `npm run test:db:trade-roster-plans`, `npm run test:db:trade-plan-concurrency` |
| Flexible playoff trees | `npm run test:db:general-brackets` |
| Roster cleanup | `npm run test:db:roster-lifecycle`, `npm run test:db:roster-oracle` |
| Daily automation | `npm run test:db:pre-tipoff`, `npm run test:db:optimizer-default` |
| Optimizer ownership | `npm run test:db:optimizer-context` |
| History retention | `npm run test:db:retention`, `npm run test:db:retention-scoring` |
| Live snapshot order | `npm run test:db:live-snapshot-order` |
| Final scores from final box scores | `npm run test:db:live-snapshot-order` for the refused later sample; `npm run check:edge-functions` for the box-score write |
| Certified scoring | `npm run test:db:skipped-week-certificates` |
| Fantasy calendar publication | `npm run test:db:calendar-publish`, `npm run test:db:calendar-seasons` |
| Draft timers | `npm run test:db:draft-timer-range`, `npm run test:db:draft-timer-pause` |
| Notification preferences and producers | `npm run test:db:notif-overhaul`, `npm run test:db:notif-producers-enabled`, `npm run test:db:notif-round3` |
| Auction turn notices, computed at commit from the settled draft | `npm run test:db:notif-t10-auction` |

These checks use controlled fixtures. They do not establish hosted latency or physical-device behavior.

## Capacity profile and paired scoring

Follow the [benchmark recipe](../scripts/bench/README.md#screen-and-job-capacity-profile).
Use identical fixtures, provider responses, runtime versions, and arguments for both versions.
Interleave observations and keep cold repair outside warm results.
Confirm equal scores, standings, and notification content before comparing speed.
Record failures, source hashes, sample counts, machine load, and measurement limits.
Keep reports and screenshots outside tracked documentation.

## Release gates

The protected workflow is named `Deploy production` in `.github/workflows/production-deploy.yml`.
It calls `Release soak` and `Hosted production readiness` before coordinated promotion.
Its jobs verify candidate/current pairings, apply the approved migration range, deploy Edge, and promote the frontend.
Rollback jobs retain the upgraded additive schema.
Vercel also enables frontend deployments from main in `vercel.json`.
Those deployments do not replace coordinated database and Edge release gates.

The [migration history](production-migration-history.md), [catalog contract](database-readiness-catalog.md), and [artifact contract](release-build-provenance.md) own those checks.
A source check or catalog pass alone does not authorize a release.
The attested candidate is `20261024000001` in both release-history and catalog contracts.
The pre-migration catalog pins 431 applied rows and the exact 63-version pending suffix.
The 329-row historical audit anchor and all earlier approved SQL fingerprints remain protected.
The [migration history](production-migration-history.md#candidate-migrations) records this boundary.
The combined bounded-season candidate and the attested range both contain 494 migrations.
Release approval permits the existing workflow to run; it does not bypass an attestation failure.

## Sleeper projections and weekly cleanup

Use an isolated local Supabase project and ports. Restore the normal config before handoff.
Never reset the shared Pancake stack.
The focused commands are:

```sh
deno test --allow-env --allow-net --allow-read supabase/functions/sync-sleeper-projections supabase/functions/sync-projections supabase/functions/_shared/retry.test.ts
npm run test:db:sleeper-fixture
npm run test:db:sleeper-projections
npm run test:db:projection-schedule
npm run test:db:retention-indexes
npm run test:db:retention-concurrency
npm run test:db:retention
npm run test:db:retention-scoring
npm run test:db:pre-tipoff
npm run test:db:fantasypros-projections
```

Database commands require the isolated local database URL.
The fixture command also requires its local API URL and service-role key.
The scoring check requires its local backend secret key.
Read these settings only from that local project's CLI status.
The database Deno tests require the explicit `--local-db` argument, supplied by their npm commands.
Ordinary Edge checks ignore those database tests.

The fixture test pulls four recorded rows twice and verifies stable IDs, updated values, reader precedence, projected sits, and failure recovery.
The SQL checks cover mixed weekly fallback, makes and attempts, next-game data, fingerprint stability, permissions, and deletion hints.
Schedule checks cover Pacific midnight, both daylight saving transitions, late checks, claims, and injury refresh windows.
Retention checks protect all league and NBA tables with write-rejecting triggers.
Index checks run actual log and snapshot deletion statements against populated fixtures and inspect their execution plans.
They also inspect indexed cron, Sleeper, FantasyPros, and run-selection plans.
All fixture writes use the isolated local project. SQL checks roll back.

The fixture checks also cover rejected and unmatched source rows, absent-game removal, and historical games after team changes.
Coverage checks verify updates without deletion below 70%, retained projected sits, failed-run diagnostics, and recovery.
SQL cases check the 70% boundary, an empty upcoming store, and exclusion of past games and other weeks.
Freshness cases cover the 36-hour boundary, source precedence, and returned timestamps.
Concurrency checks hold row locks while cleanup and new writes run together.
Keep generated results with the release evidence; rerun checks for the candidate under review.

## Player detail

```sh
npx vitest run tests/components/player/player-detail.test.ts tests/app/player-browser-seasons.test.ts tests/hooks/player-screen-projection-lifetime.test.ts
```

These checks cover roster controls, season selection, compact statistics, projection labels, recent games, and collapsed league history.
Use the [browser setup](../tests/e2e/README.md#supported-web-clients) for supported-client layout and interaction checks.
[PWA behavior](pwa-live-data.md#player-detail) owns the screen contract.

## Dependency security

The lockfile resolves Vite 8.3.5 and Zod 4.6.7 for the branch's security updates.
Use `npm ci` to install the reviewed tree.
`npm run security:audit` rejects unaccepted high or critical advisories and stale accepted exceptions.
`scripts/check-dependency-audit.mjs` owns exception reasons and removal conditions.
A passing audit does not mean the tree contains no advisories.
