# PWA and live data operations

Pancake keeps the installed shell fast. It keeps live data outside the service worker cache.

## Architecture

1. The release build creates static route files and hashed assets.
2. The document paints a static boot shell before any JavaScript runs.
3. The service worker handles same-origin documents and static assets.
4. Supabase handles authentication, database reads, and row security.
5. Realtime channels deliver matchup, lineup, draft, and roster changes.
6. Application caches give safe data an immediate first paint.
7. Edge jobs update schedules, players, scores, projections, rankings, and draft order.

See [source monitoring](./source-monitoring.md) for upstream health and recovery.

## Boot shell

The web build is a client-rendered app. Its exported HTML holds an empty root
element, so nothing reaches the screen until the JavaScript bundle mounts React.
On an installed PWA over a mobile link that was seconds of blank screen.

`constants/boot-shell.ts` emits the persistent chrome as static HTML and CSS.
The document carries it, so it paints from the HTML alone.

- It is built from the same design tokens as `WebTabShell`. The two cannot drift.
- An inline script reveals it only when local storage holds a Supabase session.
  A signed-out or auth-route launch never shows app chrome.
- The same script fills the league, team, initials, and active route from the
  persistent cache. It skips that text past thirty days and paints plain chrome.
- Every navigation item is a real link, so the shell navigates without the bundle.
- Icons are inline SVG. The chrome never waits on an icon font.
- `useBootShellHandoff` removes the shell in a layout effect, before the real
  chrome paints. The handoff shows no flicker and no duplicate navigation.

The shell records `pancake-boot-shell` and the handoff records
`pancake-app-mounted`. The gap between them is how long the static chrome held
the screen alone. `window.__PANCAKE_BOOT__` keeps what the shell painted.

### What the boot shell must never do

It paints chrome and cached identity only. It never paints scores, lineups,
rosters, trades, or any value whose staleness could mislead a roster decision.
It reads only this user's own storage. It writes nothing.

## Cache policy

| Data | Policy | Invalidation |
| --- | --- | --- |
| App shell | Cache first, then refresh `/` | Every release gets a new cache version. |
| Boot bundle and fonts | Precached during install | The release's own manifest lists them. |
| Hashed assets (`/_expo/static`, `/assets`) | Cache first | The filename is the version. |
| Other same-origin assets | Stale while revalidate | A new URL creates a new entry. |
| Supabase API | Never intercepted | Each request reaches Supabase. |
| Realtime | Never intercepted | The socket reconnects to Supabase. |
| Matchup data | Same-day, user-scoped local cache | Focus, realtime, or reconnect refreshes it. |
| Other screen data | User, league, and resource scoped | TTL, focus, mutation, or sign-out clears it. |

The release cache version contains the commit and a build fingerprint. A same-commit rebuild still creates a new version.

`scripts/stamp-release-provenance.mjs` writes the version and the precache
manifest into `dist/sw.js` at build time. The manifest lists exactly what the
shell HTML boots from: its scripts, its stylesheet, the web manifest, and the
brand mark. Per-route chunks stay lazy. The stamp fails the build when the
worker declares no manifest, so a deploy cannot ship a cold bundle.

Fonts are in the manifest for a specific reason: they are fetched by the bundle,
not the document, so they only start downloading once the app has mounted. Left
alone, the real chrome rendered empty icon boxes for about two seconds after the
shell handed off. The rule is mechanical — any font under `dist/assets` whose
filename appears in the built JavaScript — so it stays correct as fonts change.

Install precaches that manifest before activation deletes the previous
release's caches. Without it a deploy dropped the old assets and the
version-change reload re-downloaded the whole bundle — a blank screen on every
release. Entries are added one at a time, so a stale URL cannot fail the install
and strand a launch with no assets.

Activation deletes older Pancake caches. The new worker takes control immediately.

The page reloads once after a new worker takes control. The first worker install does not reload the page.

Every cache path falls back to the network. An evicted, disabled, or corrupt
cache cannot break a launch.

## Offline and reconnect behavior

The installed shell opens without a network. Cached matchup and lineup data remain visible.

A failed refresh stays visible. The error banner shows that cached data can be stale.

Lineup and roster writes require the server. Pancake does not queue time-sensitive sports actions offline.

The browser `online` event clears season and week lookup caches. Home then reloads the current matchup.

Realtime subscriptions reconnect separately. Cross-tab events still update active screens.

## Recovery

1. Confirm the error banner and browser connection.
2. Restore the network.
3. Wait for the matchup refresh.
4. Reload once if the banner remains.
5. Check source health when server data stays stale.
6. Clear site data only after normal recovery fails.

For a bad release, deploy the last verified build. Its cache version replaces the failed build.

## Verification

Run the release build before browser checks.

```sh
npm run build:web:release
npm run e2e:browser-pwa-launch
npm run e2e:browser-perf
npm run e2e:data-latency
npm run perf:budget -- --require-report --require-data-report
```

`e2e:browser-pwa-launch` is the launch gate. It relaunches the signed-in path
and checks that the shell paints, paints before the app takes over, paints the
cached league, team, and active route, hands off without duplicate chrome,
survives a background-to-foreground return and a week-old cache, holds every
boot asset it declares, and still launches offline. Signed out, none of the
chrome may appear. It runs in the CI browser matrix as `pwa-launch`.

`e2e:pwa-update` is the deploy gate. It needs two built directories:

```sh
npm run e2e:pwa-update -- --previous=<dist-of-live-release> --next=dist
```

It installs the previous release's worker, swaps the origin to the next
release, and checks that each release precaches what it declares, that only the
activated release keeps caches, and that the first relaunch after the deploy
still mounts. Run it before promoting a release whose asset hashes moved.

The dated evidence lives in [`evidence/2026-08-23-instant-pwa/`](./evidence/2026-08-23-instant-pwa/)
and [`evidence/2026-08-27-instant-paint/`](./evidence/2026-08-27-instant-paint/).

## Known limits

The first install needs one online load before every route asset can enter the cache.

The boot shell does not shorten the bundle. It covers the wait; it does not
remove it. A cold first install still downloads the bundle before the app is
interactive. The shell is chrome, not the screen's content.

A first-ever install fetches the fonts after mount, because the worker only
installs once the page has loaded. Precaching fixes every launch after that.

The precache is roughly a megabyte, most of it the bundle. It is fetched in the
background after load, so it never blocks the launch that triggers it.

A signed-out launch still shows the plain background until the bundle mounts.
The shell stays hidden there on purpose: painting app chrome for someone who is
about to see a sign-in screen would be a worse flash than the background.

Browser background limits can delay sockets on an idle home-screen app. Foreground and reconnect refreshes correct missed data.

Offline data is a last known snapshot. The error banner marks its uncertain freshness.

Offline writes remain disabled. This avoids invalid moves after a game lock or roster change.
