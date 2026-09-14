# Cleanup gate — t_a4dc0293 hardening

Run ID: 723bc7a3079044d0bb16031fc79b3dec
Status: complete
Base: 2909a0ad669b657390f22c9edc4f3d8d130793d3

## Passes

1 of at most 1 pass: deslop, simplify, conservative test pruning, stale docs.
Scope: the 89 non-evidence files in the diff were reviewed (app, hooks, lib, public/sw.js, edge functions, SQL, tests, docs).
Product code, SQL and migrations were not changed. Any behavior change would void the 20-season release proof at 9fa03e2.
Residual seen, not fixed (implementer's work, not cleanup): `lineup-optimizer/index.ts` touches a member's setting when `failed > 0`. `failed` counts the whole run, so after one member fails, later members with zero optimizations are also touched.

## Rebase

Not needed. The coordinator checked ancestry.

## Removed

- `tests/e2e-harness-fixtures.test.ts`: unused `filters` field in the fake PostgREST builder state.
- `tests/e2e-pwa-paint-probe-entry.test.ts`: unused `failed` destructure and its `void failed` statement.

## Tests deleted

None. Every added test can fail. The source-contract tests fail when the wiring they pin changes.

## Docs updated

- `tests/e2e/README.md`: "the paint probe above" now says "below". The probe section follows that paragraph.

## Verified

- `npx vitest run tests/e2e-harness-fixtures.test.ts tests/e2e-pwa-paint-probe-entry.test.ts`: exit 0, 2 files, 21 tests passed (run synchronously after the edit).

## Checks

Bounded plan: the coordinator's base/current receipts in `cleanup-gate-01`.
Coordinator prechecks (before this pass), raw exit codes:
- base: core 0, dependencies 0, edge-shared 0, function-sources 0, unit 0.
- current: core 0, dead-code 0, dependencies 0, e2e-types 0, edge-shared 0, function-sources 0, lint 0, test-types 0, unit 0.
These are bounded checks, not a green full-repository typecheck.
Coordinator postchecks: not run yet. The coordinator runs them after this gate exits.
No full-suite, lint or typecheck job was started by this gate.

## Commits

- 951504f chore(cleanup): drop unused test scaffolding; fix e2e README cross-reference
- this report (CLEANUP.md)

## Reverted

none
