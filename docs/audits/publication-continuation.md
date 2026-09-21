# Publication continuation evidence

Implementation starts at `65cb97fcf7fa6e2321f559fc8b31bde6767e96af`.
Evidence lives outside the shipping tree:
`/Users/michaelchen/.hermes/kanban/workspaces/t_4e927254/evidence/`.

`parent-artifacts.tar.gz` preserves 5,928 prior files, including the parent worklog,
all hardening review rounds, raw results, screenshots, and generated reports.
`deletion-ledger.json` lists every archived/deleted path, reason, size, and SHA-256.
The archive was reopened and every file hash verified before deletion.
The original archive on mbp-old remains untouched.

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
Two remote commits change league behavior and security; integration remains required.
No PR exists for this branch at the initial read-only inspection.
Fresh checks on this branch do not certify the eventual merge with main.
