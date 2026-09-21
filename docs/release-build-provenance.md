# Release build provenance

`npm run build:web:release` clears Metro transforms, exports the web app, and
stamps the complete output with its source commit and SHA-256 digest.
The digest includes every output file except the marker itself, plus the four
deployment inputs listed in the marker. It does not normalize output bytes.

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

Expo also allocates numeric module IDs through one shared counter. Concurrent
server and client exports can reach that counter in different orders, even
with one worker. The configuration gives each web runtime environment its own
upstream ID factory. Server rendering no longer consumes browser module IDs.
Modules within each environment retain Expo's allocation rules. Native and
unscoped calls retain the original shared factory. Worker count stays unchanged.

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
