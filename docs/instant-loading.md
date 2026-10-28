# Loading rules

Screens keep their frame during loading and refresh.
Saved content appears before background checks.

## Stable loading surfaces

Cold screen views reserve content space without a loading sentence, spinner, or looping shimmer.
Matching saved rows stay visible during refresh.
Errors and offline notices remain visible and accessible.
An empty result differs from a failed or unfinished read.
Home preserves a confirmed empty-matchup notice across returns and failed refreshes.
Unconfirmed membership cannot establish a new empty result.
Auth forms keep their frame until the matching live route is ready.
Web fonts use preloads and optional loading to reduce movement.

## Cache and offline

Screen loaders read one complete `/views/<screen>` response.
The browser does not join separate reads to build those screens.
Details, explicit searches, and later pages can request new views.

The cache stores schema version, league version, scope, and data.
Keys include account, league, member, season, screen, and sorted parameters.
A current-season lookup resolves to its stored season ID.
The cache holds at most 48 entries and 4 MiB of JSON.
Old entries leave first.
Storage denial leaves in-memory content available.

A saved result renders on the first render.
A clean cached screen reopens with zero requests before background refresh.
A cold screen reads one view without a separate version request.
The rookie draft controller also requests the league version.
These counts exclude shared authentication, membership, and change-stream setup.
They measure hooks, not complete browser network traffic.

Cold reads wait for the shared change stream to avoid duplicate view requests.
Background checks, foreground return, and reconnect reconcile the league version.
An unchanged version needs no view read.
Changed topics refresh affected views.
A missing change range requires a fresh view.
Realtime versions use the same invalidation path.
Hidden screens defer reads until active.
There is no unchanged-data polling timer in screen loaders.

Account changes clear private content and reject late responses.
League selection clears screen results before showing the next member.
Offline screens keep saved text and show the offline notice.
A screen without saved content cannot load offline.

Queued actions store account, league, affected rows, input, and request ID.
They store no access token.
Reconnect sends actions in order with the matching account.
A failed action blocks later actions and keeps its input.
Retry sends that action with the same request ID.
Affected rows show Pending until the server accepts the action.
Database receipts prevent duplicate effects after an uncertain response.
Server checks still decide authorization and roster legality.

## Background results

Background workers publish a league version when result fields change.
Refresh metadata alone causes no version change.
Publication hints do not queue another refresh.
Standings, matchup totals, averages, and trade values use stored server results.
Forecasts and quote-free trade estimates also compute outside screen loads.
Stale data stays identifiable while work completes.

## Checks

`tests/e2e/performance-budgets.json` owns workflow budgets.
`tests/e2e/surface-matrix.json` maps routes to scenarios.

```sh
npm run check:surface-matrix
npx vitest run tests/lib/cache/screen-cache.test.ts tests/lib/cache/mutation-queue.test.ts tests/hooks/screen-view-lifecycle.test.ts tests/screen-request-counts.test.ts
npm run perf:budget
npm run e2e:layout-stability -- --help
```

Use the [layout recipe](../tests/e2e/layout-stability-README.md) with a stamped local release.
Run recorder negative controls before accepting a sweep.
Chromium reports CLS.
WebKit uses geometry and frame sampling.
Browser measurements do not prove physical iPhone behavior.

| Browser recipe | Evidence |
| --- | --- |
| `screen-view-parity.mjs` | Seeded text parity and request counts at 390×844 |
| `screen-offline-replay.mjs` | Saved input, failed replay, retry, and one effect after duplicate delivery |
| `screen-write-freshness.mjs` | Accepted trade and awarded waiver after publication |
| `screen-cache-identity.mjs` | League switch, sign-out, and next-account isolation |

These scripts live in `tests/e2e/` and require an isolated local stack.
The [integration record](release-2.4-integration.md) keeps the earlier measured results.
The [PWA contract](pwa-live-data.md) covers public assets, updates, reconnects, and push.
