# Verification

Verify every change on an isolated local stack.
Use [verify-pancake](../.claude/skills/verify-pancake/SKILL.md) for browser journeys and evidence.
Start it with `npm run verify:launch`.

## Rules

- Use an isolated checkout, Supabase project ID, and port block for database or browser fixtures.
- Never reset the shared Pancake stack.
- Never use another lane's stack.
- Never reuse the user's browser; use a separate automation browser.
- Do not copy private environment files between checkouts.
- Do not apply local dispatch wiring to a hosted project.
- A skipped check or a missing metric is not a pass.
- Negative controls must fail the same assertions used for acceptance.
- The full suite must report zero failures.
- Keep generated reports and screenshots outside tracked source.
- A report from another source version does not certify the candidate.

## Local stack

Use Node 22, Docker, the Supabase CLI, and PostgreSQL client 15 or newer.

1. Set the isolated project ID and all ports in `supabase/config.toml`.
2. Run `supabase start`.
3. Run `supabase status -o env` and copy the local values into `.env` from `.env.example`.
4. Run `supabase functions serve --env-file .env`.
5. Run `npm run e2e:seed` if the check needs the shared browser fixture.
6. Run `npm run build:web:release`.
7. Run `node tests/e2e/static-web-server.mjs --root=dist --port=8082` and set `E2E_FRONTEND_URL` to it.

The seed deletes the previous seed's league and users, so use only disposable data.
Internal jobs need `PANCAKE_EDGE_INTERNAL_TOKEN` to match the database dispatch token.
The dispatcher reads `app.edge_internal_token` and `app.supabase_url`, or their Vault fallbacks.

For `npm run test:db`, set `PANCAKE_TEST_DB_PORT`, `PANCAKE_TEST_API_PORT`, and `PANCAKE_TEST_PROJECT_ID` to this checkout's values.
Keep them aligned with `supabase/config.toml` for the whole run.
Stop the stack and remove `supabase/.temp/start-secrets` before you run the quality gate.

## Checks

| Check | Command |
| --- | --- |
| Lint, types, dead code, and generated-source parity | `npm run check:quality` |
| Unit and contract tests | `npx vitest run` |
| Database recipes | `npm run test:db` |
| One database area | `npm run test:db:<area>`; list them with `npm run` |
| Edge runtime | `npm run check:edge-functions` |
| Database types and function catalog | `npm run check:database-types`, `npm run check:db-function-catalog` |
| Dependency advisories | `npm run security:audit` |
| Browser clients | `npm run e2e:web-targets` |
| Layout stability | `npm run e2e:layout-stability -- --help` |
| Performance budgets | `npm run perf:budget` |
| Season soak | `npm run e2e:soak:release` |

Run focused tests while you work.
Run the full suites before a release.
`npm run test:db:bugs` reproduces known product bugs from `tests/db/known-bugs.json`; it fails when a bug no longer reproduces.

## Documentation checks

These tests read docs and need no database:

```sh
npx vitest run tests/release-edge-compatibility.test.ts tests/e2e-release-contracts.test.ts tests/release-script.test.ts
npm run check:surface-matrix
node scripts/regenerate-release-history-attestations.mjs --check
```

The release-order test reads `supabase/RELEASE-DB.md`.
It fails when the release order, production head, or newest migration is missing.

## Local builds

Keep `VERCEL_ENV` non-production and `PANCAKE_FETCH_PREDECESSOR` unset for local builds.
For update checks, point `PANCAKE_PREVIOUS_RELEASE_ROOT` at a verified local export.
This keeps local builds from contacting the live release.

## Installed iPhone checks

Use `node scripts/ios-sim/run.mjs --help` for repeatable simulator captures.
Before a release, check these on a real iPhone: Home Screen launch, keyboard placement, status bars, scroll restoration, and background return.
Browser emulation does not prove them.

## Historical replay acceptance

Use the [season simulator](../scripts/season-sim/README.md) to collect, replay, and clean up.
A resumed replay proves only its measured dates and actions.
A late start records earlier windows as unmeasured and keeps `fullAcceptance` false.
Check scores against an independent oracle, plus ownership, pick history, rollover, and the cutoff.
Keep missing source data separate from arithmetic failures.
Outbox rows do not prove push delivery or device display.

## Tool guides

- [Browser checks](../tests/e2e/README.md) and [layout stability](../tests/e2e/layout-stability-README.md)
- [App performance](../tools/perf/README.md) and [verify tools](../tools/verify/README.md)
- [Capacity benchmarks](../scripts/bench/README.md) and [game-night replay](../scripts/bench/game-night/README.md)
- [Season simulator](../scripts/season-sim/README.md)
- [Mutation tests](../scripts/mutation/live/README.md) and [post-game mutation tests](../scripts/mutation/post/README.md)
- [Load tests](../scripts/load/README.md)
