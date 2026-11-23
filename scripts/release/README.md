# Release from a Mac

Run `npm run release -- --dry-run --candidate <full-sha>` first.
The runner reads `evidence/release-inputs.json` by default. Use `--config <file>` to select another file.
It needs Node 22, Git, Supabase CLI, gh, Deno, and tar. Database dumps also need Docker.
Use the logged-in Supabase and gh CLIs for a live release.
Do not put production credentials in input files or receipts.
The production Supabase project is `ceeytbfmwsnzalxlkalc`.

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

Paths resolve from the candidate checkout. Check-log paths resolve from the checks receipt's folder.
Keep evidence outside tracked files.
`expectedMain` must match the local `origin/main` reference.
The candidate must include that reference and equal HEAD.
The checkout must be clean, including untracked files.
A dry run also permits a clean detached checkout. A live release needs a branch other than main.

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

A replay can record its candidate in `source.application.commit` instead.
`fullAcceptance: true` can replace the `lateStart` fields.
Any recorded error, failure, cleanup error, or invariant failure blocks the release.
Do not invent replay evidence to unblock a rehearsal.
The late-season summary has no source commit. Wrap it with its verified commit and keep the original beside the wrapper.

The checks receipt records the full local checks:

```json
{
  "candidate": "<full-candidate-sha>",
  "passed": true,
  "commands": [
    { "command": "npm run check:comprehensive", "exitCode": 0, "log": "quality.log", "sha256": "<log-sha256>" },
    { "command": "npm run check:gate", "exitCode": 0, "log": "gate.log", "sha256": "<log-sha256>" }
  ]
}
```

Logs must exist and match their hashes.
The runner does not rerun the full suites. A focused check alone does not satisfy this receipt.

The dry-run pull request receipt stands in for GitHub:

```json
{
  "headRefOid": "<full-candidate-sha>",
  "baseRefOid": "<full-origin-main-sha>",
  "baseRefName": "main",
  "state": "OPEN"
}
```

## Rehearse locally

Use a private mini stack with project ID `pt4bafablerelease` and ports 59400 through 59499.

1. Copy the candidate's Supabase files into `stackRoot`, outside the candidate checkout.
2. Disable automatic migrations and seeds, start the stack, disable cron, then apply the candidate migrations.
3. Follow the [local stack setup](../../docs/verification.md#local-stack) for keys, functions, and the web export.
4. Stamp the local Edge source with the candidate SHA, and keep its deployment inputs.
5. Serve the release export and API on loopback.
6. Run the rehearsal:

```sh
node scripts/release/release.mjs --dry-run --candidate <full-sha>
```

The rehearsal runs every stage against local targets.
It calls `supabase db push --local --dry-run` before both database stages.
It never applies migrations in this mode.
No Supabase deploy, gh command, Vercel call, or remote Git query runs.
The receipt marks simulated steps. It does not prove hosted behavior.

## Release live

Use HTTPS targets, add `projectRef` and `pr`, and omit local-only inputs.
Link the checkout to the Supabase project first.
Use a reviewed PR with the exact candidate head and main base.
Set `expectedBundleDigest` when you have an independently verified digest. `waitSeconds` defaults to 600.
Keep the previous deployed Edge commit in local Git history.
Its trusted source must reproduce the live health digest exactly. A mismatch blocks the release.

```sh
npm run release -- --candidate <full-sha> --config evidence/live-release-inputs.json
```

The order is preflight, backup, changed Edge, DB dry run, DB push, squash merge, frontend wait, provenance, Edge restamp, smoke, and receipt.
This runner is Edge-first, unlike the manual order in the [database runbook](../../supabase/RELEASE-DB.md).
Replay evidence must cover Edge compatibility with the old database.
The changed-function set comes from `git diff --name-only origin/main...HEAD -- supabase/functions`, plus shared importers. `api` always deploys.
DB planning must list exactly the candidate migrations absent from the target.
The real push must leave migration history equal to candidate history.
The squash commit must have the expected main parent and candidate tree.
Smoke needs healthy Edge, a fake chunk that returns `404` with `no-store`, and zero recent invocation errors.

## Resume and roll back

State lives in `evidence/releases/<candidate>/<dry-run-or-live>/state.json`. Use `--state <file>` to move it.
A lock stops two runs from sharing one state.
After a crash, confirm the old process stopped, then remove its `.lock` directory.
Rerun the same command to resume at the first unfinished step.
Completed backups and receipts must retain their recorded hashes.

```sh
npm run release -- --rollback --candidate <full-sha>
```

Rollback reads its inputs from state, verifies the backup, and redeploys the saved previous Edge source.
New functions that the previous release lacks stay deployed and appear in the rollback receipt.
The command prints the saved recovery SQL path.
It never executes recovery SQL or reverses database migrations.
Roll back the frontend yourself. A rolled-back state cannot resume promotion.
Use `--dry-run --rollback` to check the saved artifact without a deploy.

## Build provenance

`npm run build:web:release` exports the web app and writes `dist/release-provenance.json`.
The marker records the source commit, a file manifest, the four deployment inputs, and a SHA-256 bundle digest.
Public copies and document markers belong to the manifest. Do not change them after stamping.

Recover a deployed artifact:

```sh
npm run release:recover-artifact -- --url <deployment> --expected-sha <sha> --expected-digest <digest> --output <new-directory>
```

The complete bundle digest must match the independently captured expected digest.
Recovered inputs serve as evidence; the recovery command never executes them.
The backup's previous Edge source digest must match live health before any deployment.
Deployed soak reports must match `E2E_DEPLOYED_FRONTEND_SHA` and `E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST`.

Production builds copy the live release's public assets so open pages can load older route scripts.
They read the marker from `https://pancakedynasty.vercel.app`. Set `PANCAKE_PREDECESSOR_URL` to override it.
The marker must contain a 40-character hexadecimal commit SHA and a 64-character hexadecimal bundle digest.
The marker must keep the same source and digest during discovery and recovery.
Remote recovery runs only with `VERCEL_ENV=production` or `PANCAKE_FETCH_PREDECESSOR=1`.
Set `PANCAKE_PREVIOUS_RELEASE_ROOT` to use a local previous export instead.
Never use an export with a different API issuer as a production predecessor.
Changing the predecessor needs a clean export.

When a route loader keeps its filename but changes its targets, the build compares the loader with only its asset paths normalized.
All other source text and dependency keys must match.
Every old target must remain available with its verified predecessor bytes, including targets that do not change.
Every new target must exist in the output.
The compatibility receipt lists copied predecessor files, so it never marks that new loader as retained.

Keep the direct `@expo/metro-config` pin equal to Expo's exact pin when you update Expo.
Then rerun repeated release builds and check that the digest stays the same.
Verify update paths with `tests/e2e/form-submission-update.mjs` when you change the service worker or draft recovery.

## Migration attestations

`tests/e2e/release-history-attestations.json` owns approved migration versions, fingerprints, and convergence bodies.
`tests/e2e/db-security-catalog-attestations.json` owns the recorded production catalog phase.
Each applied range member must match its statement count and stored-SQL fingerprint.
Each `convergenceRedefinitions` entry must name an approved migration containing the recorded body in dollar-quoted SQL.
A later schema release must extend the reviewed range and update changed convergence expectations.

Refresh the attestations only from an isolated local stack with every repository migration applied:

```sh
node scripts/regenerate-release-history-attestations.mjs
node scripts/regenerate-release-history-attestations.mjs --check
npm run security:db-catalog -- --local --phase=post-migration
```

Set `SUPABASE_DB_URL` and `PANCAKE_TEST_DB_PORT` to that stack.
Reset the stack after you change an applied migration.
An ordered upgrade must match a fresh installation at the same candidate version.
Do not regenerate pins from an unexplained live difference.
Advance the production catalog only with evidence captured at the exact deployed version.
An authorized manual application must exclude concurrent migration writers and repeat the immediate checks against the successful soak's plan digest.

## Focused checks

```sh
npx vitest run tests/release-script.test.ts
npm run lint:all
npm run typecheck
npm run typecheck:tests
```
