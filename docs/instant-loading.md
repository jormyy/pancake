# Instant Loading Plan

The performance operating plan. The source of truth for thresholds and workflow
rank is `tests/e2e/performance-budgets.json`.

## Top Workflows

| Rank | Workflow | Primary wait to remove | Measurement |
| --- | --- | --- | --- |
| 1 | Open Home and review live matchup/lineup | matchup, lineup, scoreboard, realtime refresh | `npm run e2e:browser-perf` |
| 2 | Change lineup day and move a player | day read plus atomic lineup RPC | `npm run e2e:browser-lineup` |
| 3 | Search/filter/sort the player pool | `search_players` RPC and projection enrichment | browser smoke plus player-search DB tests |
| 4 | Open a player detail screen | player row, averages, game log, fantasy points | full browser route sweep |
| 5 | Open roster and manage IR/taxi/picks/claims | roster, picks, claims, league-scored averages | `npm run e2e:browser-smoke` |
| 6 | Add a free agent or submit a waiver claim | transaction state, claim modal, atomic claim/add RPC | `npm run e2e:browser-waiver` |
| 7 | Review/propose/act on a trade | trade list, roster/pick candidates, trade action RPC | `npm run e2e:browser-trade` |
| 8 | Join auction draft room and place a bid | draft state, budgets, nomination, realtime fanout | `npm run e2e:browser-perf` |
| 9 | Open rookie draft room and make/observe a pick | draft board, rookie board, timer, pick RPC | `npm run e2e:browser-rookie-draft` |
| 10 | Open Dynasty Hub rankings/news | cached news and rankings first page | browser smoke plus dynasty static tests |

## Budgets

- Launch: useful chrome on screen under 400ms, and the static shell may hold the
  screen alone for at most 8s before the app takes over.
- UI feedback: under 100ms for common taps, filters, and text input.
- Cached or lightweight data request: under 300ms.
- Full workflow/page load: under 1s.
- Database hot query: target under 100ms.
- Browser long task: target under 50ms.

Launch is measured separately from the workflows above. A workflow budget starts
once the app is running; the launch budget covers getting there.

## Regression Gates

- `npm run e2e:browser-pwa-launch` enforces the installed-PWA launch path: the
  static shell paints before React mounts, paints the cached identity and route,
  hands off without duplicate chrome, survives background return and cache
  aging, precaches its boot assets, and launches offline. Runs in CI as the
  `pwa-launch` browser scenario.
- `npm run e2e:pwa-update -- --previous=<dir> --next=<dir>` enforces the
  deploy-update launch against two built releases.
- `npm run perf:budget` validates the ranked workflow manifest and writes
  the ignored `tests/performance-budget-report.md` run artifact.
- `npm run e2e:browser-perf && npm run perf:budget -- --require-report`
  enforces the ignored structured browser perf report when a seeded E2E
  environment is available.
- `npm run e2e:data-latency` measures authenticated Supabase/PostgREST/RPC
  request latency for all top workflow ids. `npm run perf:budget` enforces this
  ignored report when present.
- `npm test` includes static guards for the performance manifest, player-search
  materialization, and first-paint read indexes.
- `npm test` also freezes two unit-level budgets. `tests/screen-request-counts.test.ts`
  counts every table read and RPC a screen load issues through a filter-aware fake
  client (players tab support 4, trade block 5, trade offers 4, trade history 4,
  player page 2 for a rostered player and 4 for a free agent, Home's two lineups 5,
  Home's week metadata 2); lowering a number is an improvement, raising one needs a
  reason in the same change. `tests/hooks/live-stats-polling.test.ts` freezes the
  live-stats poll: 2 reads per snapshot, none while the page is hidden.
  `tests/list-render-counts.test.ts` asserts that starting or finishing one add in a
  20-row player list re-renders exactly one row.
- `tests/hooks/leagues-coalescing.test.ts` counts membership reads, Home matchup reads, and context renders with fixed response delays.
  It covers bursts, continuous events, pending reads, return signals, unchanged rows, removals, and owner changes.
  Membership refreshes use a bounded 250 ms window and one queued follow-up.
  Startup reads remain immediate; unchanged rows avoid downstream Home reloads.
- `tests/hooks/pending-trade-count-coalescing.test.ts` runs the real count RPC wrapper with fixed response delays.
  It covers trade and participant bursts, held reads, route and focus catch-up, retry limits, owner changes, and cleanup.
  It also checks counts above forty offers and the 250 ms maximum batching window under continuous events.
- `tests/hooks/rookie-draft-coalescing.test.ts` counts board reads, prospect reads, revision probes, and picked-player removal time.
  It covers both watched tables, repeated notifications, resets, slow reads, hidden return, failures, search, taxi, and expiry.
  Rookie reloads use a bounded 250 ms window; the 15 s revision poll permits one pending probe and reload.
- `tests/hooks/live-data-unchanged-references.test.ts` counts memoized consumer renders and view-row allocations with 240 synthetic players and fixed response delays.
  It covers unchanged polls, game transitions, DNP, corrections, lineup edits, date changes, partial failures, disconnect, and resume.
  Silent Home refreshes reuse equal lineups after the existing owner and date checks. Reads and lineup fanouts keep their cadence.

## Latest Measurements

The 2026-10-13 results (startup relaunch, realtime bursts, screens, soaks) and their limits are in
[verification.md](./verification.md#latest-local-results--2026-10-13).

Measurements use headless Chromium, the local stack, a 390×844 viewport, 150 ms RTT / 1600 kbps, and six interleaved runs per case.
Expired-token relaunches improve from 0/6 reaching the saved league, with sign-in and wrong-league flashes, to 6/6 at ~250 ms without flashes.
The result holds with 25-hour-old caches. Valid-token relaunches stay unchanged at ~35 ms.

### Launch — 2026-08-27

Blank-screen duration (time to first contentful paint) in headless WebKit,
seeded with a returning user's storage, over 1600kbps / 150ms RTT, one browser
context per launch. "Relaunch" is the installed-PWA case users see every day.
Full table and raw runs: [`evidence/2026-08-27-instant-paint/`](./evidence/2026-08-27-instant-paint/).

| Launch | Before | After |
| --- | ---: | ---: |
| Cold `/` | 2571ms | 332ms |
| Relaunch `/` | 2297ms | 33ms |
| Relaunch `/roster` | 2301ms | 29ms |
| Relaunch `/players` | 2289ms | 34ms |
| Relaunch `/trades` | 2270ms | 27ms |
| First relaunch after a deploy | full re-download | 19ms |

Cold `/roster` and cold `/trades` read ~325ms in both builds: those routes
prerender enough markup to trip first paint already. The app still did not mount
until ~2.5s before the change; after it, the same paint is the real chrome.

In-app route changes were already fast and did not regress: 33-70ms before and
after, within noise at this scale, so no route chunk is fetched and route
prefetching would buy nothing.

### Data — 2026-08-23

Validated against a seeded release build and local Supabase.

| Signal | Baseline | Current | Budget |
| --- | ---: | ---: | ---: |
| Home cold data-ready | 2337ms | 715ms | 1000ms |
| `search_players` first page RPC | 123.8ms median | 19.6ms median | 100ms |
| Home day feedback | not gated | 9.3ms | 100ms |
| Home warm request | not gated | 6ms | 300ms |
| Home live-update long tasks | not gated | 0 | under 50ms each |

All ten authenticated data workflows pass. Their median totals range from 9.6ms to 23ms.

Player search now uses a request-specific database plan. It keeps paging and projection behavior unchanged.

## Current Implementation Notes

- The document paints a static app shell before application JavaScript runs. See
  [pwa-live-data.md](./pwa-live-data.md#boot-shell).
- The service worker precaches the boot bundle at install, so a deploy relaunches
  from disk instead of re-downloading.
- League membership, player search, roster, and Dynasty news keep cached data
  visible while refreshing.
- An online reopen waits for an expired session's refresh before routing. It does not show sign-in during that wait.
- The saved league choice has no age limit. Memberships stay available for thirty days while the server refreshes them.
- Cache pruning keeps both startup entries. Sign-out and account changes still clear private caches.
- Only a server membership result can replace a saved choice. A stale list cannot select a different league.
- Home matchup/lineup and player detail screens hydrate same-day cached content
  immediately, then refresh in the background.
- Player search uses materialized read models and pages before projection
  enrichment so the request is bounded.
  The server sorts the full filtered pool before pagination, including rookies. The client preserves that order.
- Roster, matchup, trade, draft, waiver, and player detail hot reads have
  targeted indexes in the 2026-07-02 instant-loading migrations.
- Browser perf smoke measures live auction/matchup update pressure and fails on
  excessive heartbeat lag or slow mutation loops.

## Smaller public delivery

The release uses the same three Outfit faces in WOFF2 format. Each web display face uses `font-display: optional` to avoid a late font swap. The document preloads display and icon fonts. The icon subset contains names referenced by source. Metro rejects new names that are absent from the subset. Regeneration and licenses live in `assets/fonts/README.md`.

Press feedback, the live pulse, and toast fades use React Native's existing animation API. Reduced-motion settings disable movement and remove toast transitions. The web bundle excludes the native URL polyfill because supported browsers provide URL and URLSearchParams.

The boot mark is 128 pixels for its 42-pixel display size. Installation icons keep their original sizes. Release stamping gives the manifest, favicon, installation icons, and boot mark content-addressed URLs under `/assets/`. The worker serves its verified shell and public assets from cache without a background body download on every launch. Worker update checks remain.

Measure new signed-out visits separately from returning chrome. A cached identity can paint the boot shell before JavaScript. That paint is not authentication, data freshness, or completed app readiness. WebKit cache measurements require persistent browser profiles. Record observed response encodings and bytes; do not estimate compression.

## Stable loading surfaces

A cold read keeps headers, tabs, and section frames visible. Busy content reserves space without loading text, spinners, or animated placeholders.
`LoadingState` reserves a flexible area with a 320-pixel minimum height and exposes a busy state.
`DeferredContent` retains the last settled children while the next view fills. Pending retained content cannot receive clicks or keyboard focus.
A session change clears retained children. Cached content never grants write authority.

Refreshes keep matching rows visible. Summaries reserve their final space and leave unknown counts blank.
Roster sections retain their configured places. Empty results appear only after the relevant read settles.
Home retains a confirmed empty-matchup notice during revalidation, navigation returns, and failed background reads.
A different owner or unconfirmed membership cannot inherit that answer.

Headers reserve delayed identity, metadata, and action space. Week-off copy reserves space for each supported reason.
Offline and read-error notices use a polite overlay on supported screens. Temporary scroll-tail space keeps rows and retries reachable.
That tail remains until it can shrink without clamping the current scroll position. Action errors retain their existing controls.

The [layout sweep](../tests/e2e/layout-stability-README.md) checks these rules across release builds.
The final release sweep records 1,870 passes, zero failures, and 50 explained navigation omissions.
All 300 empty-notice returns pass. Chromium CLS is zero; WebKit CLS is unsupported.
The largest sampled displacement is 1.6 CSS pixels, below the unchanged two-pixel threshold.
No blank frames, loading/spinner cells, or reappearances are recorded.
Small steps at or below 0.5 pixels can accumulate without saved movement details and can understate settling time.
Source: release evidence `sweep/round5-handoff.md`, `sweep/final/compare.md`, and `sweep/final/metric-support.md` for release `aff7aac1`.

### Research sources

The research record dates from October 19, 2026. These sources guide the loading rules; measured browser support comes from the sweep.

- [web.dev: CLS](https://web.dev/articles/cls) and [Optimize CLS](https://web.dev/articles/optimize-cls): reserve space and measure visible movement.
- [NN/g: Skeleton Screens](https://www.nngroup.com/articles/skeleton-screens/) and [Response Times](https://www.nngroup.com/articles/response-times-3-important-limits/): avoid brief progress flashes.
- [MDN: LayoutShift](https://developer.mozilla.org/en-US/docs/Web/API/LayoutShift) and [compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/LayoutShift.json): distinguish unsupported CLS from zero.
- [React: useTransition](https://react.dev/reference/react/useTransition): retain revealed content during pending work.
- [TanStack: Placeholder Query Data](https://tanstack.com/query/latest/docs/framework/react/guides/placeholder-query-data) and [Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults): retain cached views while refreshing.
- [Workbox: Caching strategies](https://developer.chrome.com/docs/workbox/caching-strategies-overview) and [web.dev: bfcache](https://web.dev/articles/bfcache): keep shell caching and return navigation predictable.
- [MDN: aria-busy](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-busy): expose pending regions to assistive tools.
- [MDN: reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) and [WCAG: Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html): avoid distracting continuous animation.
