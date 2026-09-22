# Release build provenance

`npm run build:web:release` clears Metro transforms, exports the web app, and
stamps the complete output with its source commit and SHA-256 digest.
The digest includes every output file except the marker itself, plus the four
deployment inputs listed in the marker. It does not normalize output bytes.

The marker also retains a sorted file manifest with sizes and SHA-256 hashes,
plus the exact four build-input files encoded as base64. It does not include
`.env` files, credentials, or provider settings. The marker remains the only
output excluded from the existing bundle digest.

`npm run release:recover-artifact -- --url <deployment> --expected-sha <sha>
--expected-digest <digest> --output <new-directory>` retrieves each declared
file and restores those original inputs. It requires the unchanged complete
bundle digest to match the independently captured expected digest. It rejects
altered, missing, extra, duplicated, reordered, or unsafe manifest entries,
changed inputs, redirects, and a marker that changes during retrieval.
Existing output directories are never overwritten. A recovered deployment is
not described as a source rebuild. The release workflow also retains its
separate exact-rebuild comparison before the local compatibility build.

Vercel's build command enables the same Metro graph option as the release
workflow. New deployment baselines can therefore retain their complete bytes
and original inputs without access to an older provider build archive.

## Stable CSS exports

Lightning CSS returns CSS module exports in an unspecified key order.
Expo serializes that order into JavaScript. A clean rebuild can therefore
change a chunk, its async references, the service worker, and the release digest.

`metro.config.js` selects `scripts/stable-css-transformer.js`. This wrapper
sorts generated CSS export maps before Expo emits JavaScript. It preserves
class names, composition order, CSS rules, and ordinary JavaScript ordering.
The wrapper uses the existing pinned Expo transformer. Unexpected generated
map shapes fail the build. The regression tests exercise real compiler output
and opposing export orders that differ without the wrapper.
The cache key includes the upstream entry point, implementation, package metadata,
and any upstream cache key. An upstream-only change invalidates cached transforms.
Keep the direct `@expo/metro-config` pin equal to Expo's exact dependency pin when
updating Expo. Update both lockfiles and rerun the single-instance regression,
quality checks, and repeated release builds.

Expo also allocates numeric module IDs through one shared counter. Concurrent
server and client exports can reach that counter in different orders, even
with one worker. Production exports give each web runtime environment its own
upstream ID factory. Server rendering does not consume browser module IDs.
Expo sets `NODE_ENV=production` before loading the export configuration.
Normal `expo start` retains its original factory because Metro's reload server
requests IDs without the export context. `expo start --no-dev` also sets
`NODE_ENV=production` and therefore enables scoped IDs. It is not covered by the
development reload guarantee; no repository script uses that mode.
Modules within each production environment retain
Expo's allocation rules. Native and unscoped calls retain their original factory.
The release command does not pin a worker count.

## Deployed baseline

The release-soak workflow requires an exact production rebuild before it tests
the deployed frontend source against a local database. That local test bundle
uses local service addresses and has a separate digest. A source commit alone
does not prove the deployed bytes. A deterministic new build also does not
retroactively reproduce an older nondeterministic artifact.

An exact archive of a deployed artifact could satisfy the byte identity check
only when the existing digest matches across the complete file inventory and
the exact deployment inputs. Missing, extra, or altered files must fail.
Public boot files alone do not establish this match. Until a complete match
is available, keep the existing workflow gate blocked. Do not mark runtime
compatibility or the full release acceptance as passed.
