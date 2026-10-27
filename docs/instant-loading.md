# Loading rules

Screens preserve their frame during loading and refresh. These rules define saved content, empty results, errors, and layout verification.

## Stable loading surfaces

Cold screens keep their frame and reserve content space.
They show no loading sentence, spinner, or looping shimmer.
Matching saved rows stay visible during refresh.
Pending retained content stays inactive until the current read permits actions.
Account changes clear private content.

Unknown counts remain blank inside reserved space.
An empty result differs from a failed or unfinished read.
Home keeps a confirmed empty-matchup notice across route returns and failed refreshes.
Unconfirmed membership cannot establish a new empty result.

Errors and offline notices remain visible and accessible.
Supported screens use overlays with enough scroll space to reach content and Retry.
Auth document forms retain their frame until the matching live route becomes ready.
Web fonts use document preloads and optional loading to reduce text movement.

## Checks

`tests/e2e/performance-budgets.json` owns workflow budgets.
`tests/e2e/surface-matrix.json` owns the route and scenario coverage map.

```sh
npm run check:surface-matrix
npm run perf:budget
npm run e2e:layout-stability -- --help
```

Use the [layout recipe](../tests/e2e/layout-stability-README.md) to seed and measure a stamped release.
Run recorder negative controls before trusting a sweep.
Chromium reports CLS. WebKit uses geometry and frame sampling because it lacks that metric.
Browser measurements do not prove physical iPhone behavior.
See [PWA behavior](pwa-live-data.md) for cache, reconnect, and update rules.

## Cache and offline

Screen loaders read one `/views/<screen>` response.
The response includes the data that the screen previously joined in the browser.
The cache stores schema version, league version, scope, and saved data.
Storage keys include account, league, member, season, screen, and sorted parameters.
A current-season lookup resolves to its stored season ID.
The cache holds at most 48 entries and 4 MiB of JSON.
Old entries leave first.

A saved result renders during the first render.
Opening a league screen checks `/version` before replacing that result.
An unchanged version needs no view read.
A changed version refreshes affected screens.
A missing change range refreshes the selected screen.
Realtime versions use the same invalidation path.
Hidden screens retain pending changes until they become active.
Account changes reject late responses.
League selection clears screen results before showing the next league.

Offline screens keep their saved text and show the offline notice.
Queued actions store the request ID, account, league, affected rows, and original input.
They store no access token.
Reconnect sends actions in order.
A failed action blocks later actions and keeps its input.
The Retry button sends that action with the same request ID.
Affected rows show Pending until the server accepts the action.
The database request guard prevents duplicate effects after an uncertain response.

The request tests cover 25 screen and tab cases.
Cold league reads require one view request and one version request.
Profile without a league requires one view request.
These budgets exclude shared authentication, membership, and hint-stream reads.
Browser counts remain separate from these isolated hook budgets.
The legacy Auctions link reuses the saved Draft tab and needs only its version check.

Run the focused checks:

```sh
npx vitest run tests/lib/cache/screen-cache.test.ts tests/lib/cache/mutation-queue.test.ts tests/hooks/screen-view-lifecycle.test.ts tests/screen-request-counts.test.ts
```

The private WebKit recipe uses `tests/e2e/screen-view-parity.mjs` at 390×844.
It waits for seeded screen content before saving text.
It compares text after removing timestamps.
`tests/e2e/screen-offline-replay.mjs` checks retained input, retry, and duplicate request effects.
The current private release passes all 20 text comparisons and request assertions.
The offline browser proof submits a real claim, forces replay failure, retries, and repeats the request.
One claim exists after retry and duplicate delivery.
The release queue uses immutable snapshots so compiled pending notices update.
`tests/e2e/screen-write-freshness.mjs` proves an accepted trade and an awarded waiver appear after one version bump each.
`tests/e2e/screen-cache-identity.mjs` proves league switching and sign-out clear private views.
It signs in the next account and checks that only its roster appears.

Background results publish a version when their fields change.
Refresh metadata alone causes no version change.
Publication hints do not queue another background refresh.

## Private browser measurement

These counts include shared membership and hint-stream reads.
The fixture uses WebKit at 390×844.

| Screen | Old requests | New requests | Text unchanged |
| --- | ---: | ---: | --- |
| home | 19 | 4 | Yes |
| roster | 25 | 4 | Yes |
| players | 11 | 4 | Yes |
| waivers | 13 | 4 | Yes |
| player | 23 | 4 | Yes |
| trades-offers | 8 | 4 | Yes |
| trades-history | 10 | 4 | Yes |
| trade-block | 16 | 4 | Yes |
| league-results | 7 | 4 | Yes |
| league-history | 8 | 4 | Yes |
| league-draftBoard | 5 | 4 | Yes |
| league-settings | 6 | 4 | Yes |
| league-mockRooms | 5 | 4 | Yes |
| league-auctions | 5 | 3 | Yes |
| lineup | 12 | 4 | Yes |
| claim-editor | 10 | 4 | Yes |
| auction | 7 | 4 | Yes |
| rookie | 8 | 4 | Yes |
| profile | 4 | 3 | Yes |
| team-roster | 11 | 4 | Yes |
