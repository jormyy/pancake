# Instant paint — 2026-08-27

Why the installed PWA showed a blank screen on launch, what changed, and the
measurements that support the claim.

## The defect

The web build is a client-rendered app. Its exported `index.html` carried 1252
bytes of empty layout divs, so the first contentful paint *was* the React mount.
Everything before that was a blank background:

- 550KB compressed (2.7MB raw) of JavaScript had to arrive, parse, and execute.
- `__common` (321KB br) and `entry` (208KB br) dominated that.
- The service worker precached only `/`. The bundle was not precached.
- `activate()` deleted every previous cache, and `+html.tsx` reloaded the page on
  a worker version change. Together those made **every deploy** a cold launch:
  drop the old assets, then force a reload that re-downloads everything.

The prior performance work measured data latency, not paint. Those numbers were
real, but they started once the app was already running.

## Why earlier measurements missed it

On localhost with a warm browser process the whole launch is ~40ms — the problem
is invisible. It only appears with a shaped link and a cold cache. The
measurements below use 1600kbps / 150ms RTT and one browser context per launch,
so storage, HTTP cache, and worker registration all start cold.

## The change

- `constants/boot-shell.ts` emits the persistent chrome as static HTML/CSS built
  from the same tokens as `WebTabShell`, plus an inline script that reveals it
  only for a stored session and fills league, team, initials, and active route
  from the persistent cache.
- `hooks/use-boot-shell-handoff.ts` removes it in a layout effect, before the
  real chrome paints.
- `public/sw.js` precaches the boot bundle at install and serves content-hashed
  assets cache-first. `scripts/stamp-release-provenance.mjs` stamps the manifest
  from the built HTML and fails the build if the worker declares none.

## Measurements

Blank-screen duration — time to first contentful paint — in headless WebKit,
seeded with a returning user's storage, over a 1600kbps / 150ms RTT link. One
browser context per launch, so storage, HTTP cache, and the worker registration
all start cold. Raw runs: [`launch-before.json`](./launch-before.json),
[`launch-after.json`](./launch-after.json).

"Relaunch" is the installed-PWA case: the worker is installed and the app has
run before. It is the launch users see every day.

| Launch | Before | After | After: shell | After: mount |
| --- | ---: | ---: | ---: | ---: |
| Cold `/` | 2571ms | 332ms | 324ms | 2614ms |
| Relaunch `/` | 2297ms | **33ms** | 16ms | 60ms |
| Repeat relaunch `/` | 49ms | 34ms | 34ms | 65ms |
| Cold `/roster` | 324ms | 328ms | 318ms | 2614ms |
| Relaunch `/roster` | 2301ms | **29ms** | 29ms | 56ms |
| Repeat relaunch `/roster` | 59ms | 27ms | 27ms | 54ms |
| Cold `/players` | 2525ms | 324ms | 318ms | 2618ms |
| Relaunch `/players` | 2289ms | **34ms** | 34ms | 64ms |
| Repeat relaunch `/players` | 44ms | 27ms | 27ms | 68ms |
| Cold `/trades` | 325ms | 334ms | 320ms | 2610ms |
| Relaunch `/trades` | 2270ms | **27ms** | 27ms | 53ms |
| Repeat relaunch `/trades` | 37ms | 25ms | 24ms | 52ms |

Read the two flat rows honestly. Cold `/roster` and cold `/trades` show the same
~325ms before and after, because those routes already prerendered enough static
markup to trip first contentful paint. What painted was fragments of layout, and
the app did not mount until ~2.5s. After the change the same ~320ms paint is the
real chrome, with the league, team, and active route on it. The number is flat;
what is on the screen is not.

Cold `/` and cold `/players` prerendered nothing, so there the number moves too:
2.5s to ~330ms.

In-app route changes were already fast and did not regress: 33-70ms before and
after, within noise of each other at this scale.

## Visual evidence

[`webkit/`](./webkit/) holds the shell and the mounted app at both widths, so
the handoff can be compared directly: `1280x900-roster-shell.png` against
`1280x900-roster-mounted.png`, and the same pair at `390x844`.

## Scenario coverage

Run against both builds. The three shell scenarios fail on the old build and
pass on the new one, which is what makes the gate meaningful.

| Scenario | Before | After |
| --- | --- | --- |
| shell paints the cached identity and route before React mounts | FAIL | PASS |
| shell paints before the app and hands off with no duplicate chrome | FAIL | PASS |
| a different signed-in user paints their own team | FAIL | PASS |
| offline launch still reaches the app from cache | PASS | PASS |
| a corrupt session hides the chrome and still boots | PASS | PASS |
| a wiped cache recovers from the network | PASS | PASS |
| after sign-out the next launch shows no app chrome | PASS | PASS |

Three-season soak on this build — full browser matrix repeated every season,
realtime, push, history, pick chain, and a mid-life migration boundary between
seasons 1 and 2: **PASS**, 66 scenario reports, zero failures, `pwa-launch`
green in all three seasons. The migration boundary reported CURRENT, which is
correct: this work ships no migration.

Deploy-update path, against two releases whose `__common` hash moved:

| Check | Old worker | New worker |
| --- | --- | --- |
| previous release precaches what it declares | FAIL (declares nothing) | PASS |
| next release precaches its own boot assets | FAIL (declares nothing) | PASS |
| only the activated release keeps caches | PASS | PASS |
| first relaunch after the deploy still mounts | PASS | PASS |
| no reload storm | PASS (3 loads) | PASS (3 loads) |

## Cost

The shell adds 17KB raw to every exported document — 5.2KB of CSS, 7.1KB of
markup, 4.8KB of script — which is about 7KB compressed on the critical path.
The precache is 3.3MB raw across 14 entries, most of it the bundle, fetched in
the background after load.

## What this does not claim

The shell does not shorten the bundle. A cold first install still downloads it
before the app is interactive; the shell covers that wait with real chrome
instead of a blank screen. The app still mounts at ~2.6s on a cold shaped link.

A signed-out launch still shows the plain background until the bundle mounts.
That is deliberate: painting app chrome for someone about to see a sign-in
screen would be a worse flash.

## Reproducing

```sh
npm run build:web:release
node tests/e2e/static-web-server.mjs --root=dist --port=8099 &
E2E_FRONTEND_URL=http://127.0.0.1:8099 npm run e2e:browser-pwa-launch
npm run e2e:pwa-update -- --previous=<previous-dist> --next=dist
```

The shaped-link A/B used a local bandwidth/latency proxy and one browser context
per launch. The gates above assert the same invariants without the shaping, so
they stay stable in CI.

## Verification note

Verified in headless WebKit (the Safari engine) and in the headless Chromium the
repo's browser matrix uses. Verification on a **real installed Safari PWA** —
Add to Dock, launch from the Dock, terminate, relaunch — is still outstanding:
that requires taking over the screen, so it needs a short approved window.
