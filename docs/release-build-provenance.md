# Release build provenance

Release artifacts record their source commit and content digest. This contract defines frontend and Edge identity, artifact recovery, and repeatable web exports.

## Frontend artifact

`npm run build:web:release` clears Metro transforms, exports the web app, and stamps the complete output.
`dist/release-provenance.json` records the source commit and SHA-256 bundle digest.
The digest covers every output file except the marker itself, plus four deployment inputs listed in the marker.
It preserves exact output bytes.

The marker contains a sorted file manifest with sizes and SHA-256 hashes.
It also retains the four build-input files as base64.
It excludes environment files, credentials, and provider settings.
Vercel's build command uses the same Metro graph option as the release workflow.

## Artifact recovery

```sh
npm run release:recover-artifact -- \
  --url <deployment> \
  --expected-sha <sha> \
  --expected-digest <digest> \
  --output <new-directory>
```

Recovery retrieves each declared file and restores the original deployment inputs.
The complete bundle digest must match the independently captured expected digest.
It rejects altered, missing, extra, duplicate, reordered, or unsafe manifest entries.
It also rejects changed inputs, redirects, or a marker that changes during retrieval.
Existing output directories remain protected from overwrite.
Recovered inputs serve as evidence; the workflow never executes them.

The compatibility gate requires the recovered digest to equal the captured live digest.
It separately builds trusted source with loopback test endpoints.
That local bundle has a different digest because its service addresses differ.
A source rebuild can also change prerendered date labels.
Recovery proves deployed bytes; a source commit alone does not.
Incomplete recovery or a digest mismatch blocks the gate.

## Stable CSS exports

Lightning CSS returns CSS module exports in an unspecified key order.
Expo serializes that order into JavaScript, which can change chunks, route references, the worker, and the release digest.
`metro.config.js` selects `scripts/stable-css-transformer.js` to sort generated CSS export maps.
The wrapper preserves class names, composition order, CSS rules, and ordinary JavaScript ordering.
It uses the pinned Expo transformer and rejects unexpected generated map shapes.
Regression tests exercise real compiler output and opposing export orders that differ without the wrapper.

The cache key includes the upstream entry point, implementation, package metadata, and upstream cache key when present.
Upstream changes invalidate cached transforms.
Keep the direct `@expo/metro-config` pin equal to Expo's exact dependency pin during Expo updates.
Update applicable lockfiles, then rerun the single-instance regression, quality checks, and repeated release builds.

## Module identifiers

Expo normally allocates numeric module IDs through a shared counter.
Concurrent server and client exports can reach it in different orders, even with one worker.
Production exports give each web runtime environment its own upstream ID factory.
Server rendering therefore does not consume browser module IDs.
Modules within each environment retain Expo's allocation rules.
Native and unscoped calls retain the original factory.
The release command does not pin a worker count.

Expo sets `NODE_ENV=production` before loading export configuration.
Normal `expo start` retains the original factory because its reload server requests IDs without export context.
`expo start --no-dev` also enables scoped IDs and has no development reload guarantee.
No repository script uses that mode.

## Document and public-file identity

Stamping emits content-addressed public files and rewrites exported HTML references.
Manifest icons use those copies; the manifest retains its root ID, scope, and start URL.
The stamper normalizes the document release marker and worker version before calculating identity.
It then stamps both, rebuilds shell digests, and records the final artifact digest.
Repeated stamping of unchanged inputs produces the same release digest.
Public copies and document markers belong to the artifact manifest. Do not modify them after stamping.

Metro can change the entry script's lazy-route map without changing its filename.
The stamper gives that entry a digest-based URL so returning browsers load the matching route map.

## Edge artifact and database rollout

The configured Edge inventory includes `sync-sleeper-projections` and `sync-player-injuries`.
Include both in the stamped Edge artifact.
Apply the approved database migrations before deploying Edge or the frontend.
The [database release steps](../supabase/RELEASE-DB.md) define the ordered checks and rollback contract.
Before Edge deployment, an absent injury function can return HTTP 404 without alerts or rapid retries.
After rollback, that function can remain deployed or be absent; the daily full player sync still refreshes injuries.
Projection read RPC shapes remain compatible with the deployed frontend.
Source-health evidence covers active Sleeper projections and the separate dormant player fallback.

Deployed soak seasons read browser provenance from the deployed frontend's `dist/release-provenance.json`.
Their reports must match `E2E_DEPLOYED_FRONTEND_SHA` and `E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST`.
The compatibility digest identifies the deployed source rebuilt for local endpoints.
The startup health loop checks the served frontend marker and Edge health before any scenario starts.

## Keep the previous release usable

An open page can request an older route script after deployment. Keep the previous release's verified public assets available at their original paths. This prevents older clients from losing unfinished edits during missing-script recovery.

Before a production build, commit `release-predecessor.json` with `url`, `commitSha`, and `bundleDigest`. Use the previous production deployment's immutable URL and its verified release marker. The build recovers and verifies the complete artifact before copying its public assets. Production builds fail without this record or when its bytes do not match.

For an isolated local update check, set `PANCAKE_PREVIOUS_RELEASE_ROOT` to the previous verified export directory. This replaces the remote predecessor for that build. Never use an export with a different API issuer as a production predecessor.

The generated `release-compatibility.json` records the retained files and their source. They stay lazy and remain outside the startup precache. Each build retains one predecessor's own assets. It excludes assets inherited by that predecessor, old HTML, and old service workers. Conflicting immutable paths fail the build. Changing the predecessor requires a clean export.

Before publishing, verify the predecessor still matches the live deployment. Test an unfinished edit in that release, update detection, closing and reopening, and offline use. Recheck the displayed release identity after deployment.
