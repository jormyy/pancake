# Loading rules

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
