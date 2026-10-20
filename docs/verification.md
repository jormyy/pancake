# Verification

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
| Certified scoring | `npm run test:db:skipped-week-certificates` |

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
Vercel also enables deployments from main in `vercel.json`.

The [migration history](production-migration-history.md), [catalog contract](database-readiness-catalog.md), and [artifact contract](release-build-provenance.md) own those checks.
A source check or catalog pass alone does not authorize a release.
