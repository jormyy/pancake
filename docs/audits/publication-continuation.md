# Publication continuation evidence

Implementation starts at `65cb97fcf7fa6e2321f559fc8b31bde6767e96af`.
Evidence lives outside the shipping tree; the publication handoff records its location.

`parent-artifacts.tar.gz` preserves 5,928 prior files, including the parent worklog,
all hardening review rounds, raw results, screenshots, and generated reports.
`deletion-ledger.json` lists every archived/deleted path, reason, size, and SHA-256.
The archive was reopened and every file hash verified before deletion.
The original archive remains untouched.

No test is deleted. Prior pruning ledgers report no eligible tests.
Source-contract, boundary, and incident regression tests remain.
Coverage is unavailable: no coverage command or provider is installed.
`before-checks.json` and `after-deletion-checks.json` record identical test commands.
Two service-worker tests fail on Node 22 before and after artifact removal.
The core suite passes. Artifact deletion does not cause those failures.

The historical 20-season pass belongs to `9fa03e2`; it is not a fresh result.
It uses synthetic upstream services and a local 304-to-307 migration.
Its 16–28 ms paint samples do not establish a statistical performance claim.
Round 7 retains 27 non-gating findings, plus earlier carried residuals.
The optimizer's run-wide failure counter still touches later zero-work settings.
Deferred security/RLS work and ambiguous league policy remain unchanged.

Remote main advances to `abc4096c873ca6d57066357929ff92c3529d8fc6`.
The common ancestor is `2909a0ad669b657390f22c9edc4f3d8d130793d3`.
Two remote commits change league behavior and security; the integration below includes both.
No PR exists for this branch at the initial read-only inspection.
The first verification section records pre-integration checks; combined-tree checks follow below.

## Fresh implementation

`public/sw.js` now keeps cache writes within the fetch event lifetime.
Cached responses still return while background refreshes finish.
Node 22 exposes two original test failures; both pass after this repair.
Two added cases protect asset and shell refresh lifetimes.
Restoring the original worker makes four cases fail; restoring the repair passes all 12.

The dependency audit initially rejects ten high-severity advisories.
The lockfile updates only three packages: xmldom 0.8.15, js-yaml 4.3.2, and smol-toml 1.8.0.
The existing audit policy and accepted image-size advisories remain unchanged.
Deno regenerates its override metadata to match the package manifest.
Upstream fixes are documented by [xmldom](https://github.com/xmldom/xmldom/security/advisories/GHSA-w2rr-34g9-rvrj),
[js-yaml](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh), and
[smol-toml](https://github.com/squirrelchat/smol-toml/security/advisories/GHSA-7w5x-hrqm-74c2).

## Pre-integration verification scope

Validation uses Node 22.23.2 and Deno 2.7.14.
`npm run check:quality`, Edge checks, and the unchanged audit gate pass.
App tests pass: 123 files, 721 tests. Core tests pass: 112 tests.
All 22 database suites, generated database types, and the function catalog pass.
The production web build and core build pass.

A separate local stack uses synthetic users and fresh repository migrations.
The perpetual-season harness passes two rollovers across four league configurations.
Its disabled-boundary control fails four assertions, as expected.
Browser acceptance uses the process-local Chrome 153 executable.
Fresh PWA launch passes offline and records FCP at 20 ms against the unchanged 400 ms limit.
This is one observed sample, not a statistical performance claim.
The runtime copy matches every checked product source hash.

No production data, migration, deployment, remote branch, or PR is changed.
The final external `handoff.md` records every command, result, limitation, and cleanup proposal.

All 23 registered browser scenarios pass, with no cleanup error.
They cover auth, create/join, auction, lineup, playoffs, rookie draft, waivers, trades, routes, and PWA launch.
Data latency and strict workflow performance budgets also pass.
`fresh-acceptance.tar.gz` preserves the fresh browser and season artifacts.

| Same command | Before cleanup | After artifact deletion | After repairs |
| --- | --- | --- | --- |
| `npm test` | 719 tests; 2 failures; 2.405 s | 719 tests; 2 failures; 2.945 s | 721 tests; all pass; 1.832 s |
| `npm test --workspace core` | 112 pass; 0.468 s | 112 pass; 0.555 s | 112 pass; 0.390 s |

Times are single wall-clock observations, not performance comparisons.
Zero tests are pruned; two regression cases are added.

Gitleaks scans the publishable working tree and every outgoing commit with redacted output.
Both scans find zero leaks; a generated invalid canary proves the scanner can fail.
A supplementary scan records each fixture finding and its specific justification.
Existing ignored local credentials remain untouched and excluded from the runtime copy.

The merge preview identifies conflicts in five files:
`app/(tabs)/players.tsx`, `hooks/use-quick-add.ts`, `package.json`,
`supabase/sql/function-catalog.json`, and `tests/hooks/quick-add-owner-identity.test.ts`.
The later user-authorized integration resolves these conflicts without history rewriting.
No cleanup helper, independent reviewer, push, PR, or deployment runs here.


## Main integration

The integration preserves main's roster lifecycle, coded pickup errors, full auction budget,
and anon transaction-state revoke alongside the branch hardening.
The quick-add hook and its owner-identity test retain main's current API and claim-modal flow.
The database test command includes all 28 suites from both parents.
The function catalog is regenerated from the combined local schema.

An additive migration aligns claim edits with main's claim-until-processed rule.
Expired uncleared entries remain editable; processed entries reject edits.
Ownership, league, season, add-limit, self-drop, and balance guards remain.
All published migrations remain byte-for-byte unchanged.
The local database applies exactly 324 repository migrations.

Tests follow main's lifecycle rule: losing a selected drop clears that selection.
Processing still fills only one available roster slot and rejects the extra claim.
Disabling the lifecycle trigger makes that regression test fail.
The roster-full contract now tests SQLSTATE handling with changed message wording.
Restoring message matching makes both behavior cases fail.
No tests are pruned or budgets relaxed.

Combined checks pass: 750 app tests, 112 core tests, 124 Edge tests, quality, and audit.
All 28 database suites, generated types, and the function catalog pass.
The production build passes on Node 22.23.2.
The local season harness passes two rollovers across four league configurations.
Its disabled-boundary control fails all four configurations.
Fresh raw results and exact commands live in the external `integration/` evidence directory.

All 23 real-browser scenarios pass on the combined source tree.
Data latency and strict report/workflow budgets pass unchanged.
PWA launch reaches the app offline and records FCP at 20 ms against the 400 ms limit.
The full run precedes the merge commit; source hashes bind it to the combined product tree.
The external handoff distinguishes this precommit stamp from the postcommit PWA verification.
