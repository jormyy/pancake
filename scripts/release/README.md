# Release from a Mac

Run `npm run release -- --dry-run --candidate <full-sha>` first.
The default input file is `evidence/release-inputs.json`.
Use `--config <file>` to select another file.
The script needs Node 22, Git, Supabase CLI, gh, Deno, and tar.
Database dumps also need Docker.
Use the logged-in Supabase and gh CLIs for a live release.
Do not put production credentials in input files or receipts.
The runner removes CLI token and database-password environment overrides.

## Inputs

Create this file before a local rehearsal:

```json
{
  "frontendUrl": "http://127.0.0.1:59480",
  "edgeUrl": "http://127.0.0.1:59421/functions/v1/api",
  "expectedMain": "<full-origin-main-sha>",
  "stackRoot": "evidence/release-stack",
  "replayReceipt": "evidence/release-replay.json",
  "checksReceipt": "evidence/release-checks.json",
  "pullRequestReceipt": "evidence/release-pr.json",
  "releaseNotes": "evidence/release-notes.md",
  "recoverySql": "evidence/recovery.sql"
}
```

Paths resolve from the candidate checkout, except check-log paths.
Check-log paths resolve from the checks receipt's folder.
Keep evidence outside tracked files.
`expectedMain` must match the local `origin/main` reference.
The candidate must include that reference and equal HEAD.
The checkout must be clean, including untracked files.
A dry run also permits a clean detached candidate checkout.
Live releases require a branch other than main.

The replay receipt must contain:

```json
{
  "candidate": "<full-candidate-sha>",
  "passed": true,
  "complete": true,
  "invariantFailures": 0,
  "lateStart": { "passed": true, "gaps": [] }
}
```

A replay can instead record its candidate in `source.application.commit`.
`fullAcceptance: true` can replace the late-start acceptance fields.
Any recorded error, failure, cleanup error, or invariant failure blocks release.
Do not invent replay evidence to unblock a rehearsal.
The existing late-season summary omits the source commit.
Wrap that summary with its verified source commit before supplying it here.
Retain the original summary and source evidence beside the wrapper.

The checks receipt records completed full local checks:

```json
{
  "candidate": "<full-candidate-sha>",
  "passed": true,
  "commands": [
    { "command": "npm run check:comprehensive", "exitCode": 0, "log": "quality.log", "sha256": "<log-sha256>" },
    { "command": "npm test", "exitCode": 0, "log": "tests.log", "sha256": "<log-sha256>" }
  ]
}
```

Logs must exist and match their hashes.
The runner consumes these receipts; it does not rerun the full suites.
Use focused tests while developing this script.
A focused check alone does not satisfy this release prerequisite.

The dry-run pull request receipt contains:

```json
{
  "headRefOid": "<full-candidate-sha>",
  "baseRefOid": "<full-origin-main-sha>",
  "baseRefName": "main",
  "state": "OPEN"
}
```

This local record rehearses the merge checks without contacting GitHub.
It does not prove that a hosted pull request exists.

## Local rehearsal

Use a private mini stack with project ID `pt4bafablerelease` and ports 59400 through 59499.
Keep `stackRoot` separate from the clean candidate checkout.
Copy its Supabase files into that folder before changing local config.
Keep migration files identical to the candidate.
Disable automatic migrations and seeds for the initial start.
Start the stack, disable cron execution, then apply candidate migrations.
Use the [local setup](../../docs/verification.md#local-stack) for keys, functions, and the web export.
Stamp the local Edge source with the candidate SHA before serving it.
Preserve the candidate's deployment inputs when computing its Edge digest.
Serve the release export and API on loopback.
Keep production credentials out of the local environment.

```sh
node scripts/release/release.mjs --dry-run --candidate <full-sha>
```

Every release stage runs its checks.
The backup reads and dumps the private database.
The runner checks Edge entries with Deno in an isolated source copy.
It calls `supabase db push --local --dry-run` before both database stages.
It never applies migrations in this mode.
It checks the local PR record and the served frontend's candidate identity.
The local candidate SHA stands in for the future squash SHA.
Health, missing-chunk caching, and recent invocation errors use real local targets.
No Supabase deploy, gh command, Vercel API call, or remote Git query runs.
Redirects fail instead of escaping loopback.
Missing replay or check evidence fails the rehearsal.
The receipt marks simulated steps and suppressed writes.
It does not certify hosted deployment behavior.

## Live release

Use HTTPS targets, add `projectRef` and `pr`, and omit local-only inputs.
Link the checkout to that Supabase project through the logged-in CLI first.
Use an existing reviewed PR with the exact candidate head and main base.
Set `expectedBundleDigest` when an independently verified deployment digest is available.
`waitSeconds` defaults to 600.
Keep the previous deployed Edge commit available in local Git history.
Its trusted source must reproduce the live health digest exactly.
A missing or mismatched prior artifact blocks release before deployment.

```sh
npm run release -- --candidate <full-sha> --config evidence/live-release-inputs.json
```

The order is preflight, backup, changed Edge, DB dry run, DB push, squash merge, frontend wait, provenance, Edge restamp, smoke, receipt.
The explicit Edge-first contract follows the manual runbook for this release.
Replay evidence must cover Edge compatibility with the old database.
The older database-first recipes do not describe this command's order.

Preflight checks the clean candidate, unchanged remote main, full checks, replay, linked project, notes, and recovery SQL.
Backup saves migration history, schema, data, frontend identity, Edge identity, and the previous verified Edge source.
The changed-function set uses `git diff --name-only origin/main...HEAD -- supabase/functions`.
It adds direct and transitive shared importers, including reexports and literal dynamic imports.
The API also deploys so health reports the complete artifact identity.
Removed or unconfigured function changes fail instead of silently skipping deployment.
DB planning must list exactly the candidate migrations absent from the target.
The real push must leave migration history equal to candidate history.
Merge uses the reviewed notes and `--match-head-commit`.
The squash commit must have the expected main parent and candidate tree.
Frontend polling reads `/release-provenance.json`; it does not need Vercel credentials.
Restamping changes the Edge commit SHA while preserving its artifact digest.
Smoke requires healthy Edge, a fake chunk returning `404` with `no-store`, and zero recent invocation errors.

## Resume and rollback

State defaults to `evidence/releases/<candidate>/<dry-run-or-live>/state.json`.
Use `--state <file>` to select another evidence folder.
A lock prevents two runs from sharing that state.
After a crash, remove its `.lock` directory only after confirming the original process has stopped.
Rerun the same command to resume the first unfinished step.
Completed backups and receipts must retain their recorded hashes.
The runner rechecks preflight, Edge identity, database history, and frontend identity on resume.
It also rechecks saved squash merges and completed smoke checks.
Inputs, mode, and candidate stay bound to the state.
A database push can repeat safely because migration history determines pending work.
An interrupted squash merge recovers the merged PR's recorded commit.
An interrupted function deploy can redeploy the same source.

```sh
npm run release -- --rollback --candidate <full-sha>
```

Rollback reads its saved inputs from state.
It does not require the original config or prerequisite files.
Rollback verifies backup hashes and redeploys the saved previous Edge source.
It checks the previous Edge identity and writes a separate rollback receipt.
New functions absent from the previous release remain deployed and appear in that receipt.
The command prints the saved recovery SQL path.
It never executes recovery SQL or reverses database migrations.
Frontend rollback remains a separate operator action.
A rolled-back state cannot resume promotion.
Use `--dry-run --rollback` with dry-run state to check the saved artifact without deployment.

## Focused checks

```sh
npx vitest run tests/release-script.test.ts
npm run lint:all
npm run typecheck
npm run typecheck:tests
```

Tests use local source fixtures and mocked commands without network access.
They cover ordering, every interrupted stage, changed shared importers, target guards, database plans, merge guards, smoke failures, and input binding.
