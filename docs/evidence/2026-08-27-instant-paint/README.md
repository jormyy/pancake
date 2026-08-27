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

Blank-screen duration (time to first contentful paint), WebKit, seeded with a
returning user's storage.

| Launch | Before | After |
| --- | ---: | ---: |
| Cold `/` (nothing cached) | 2526ms | 353ms |
| Relaunch `/` | 2280ms | 32ms |
| Repeat relaunch `/` | 77ms | 15ms |
| Relaunch `/roster` | 2256ms | 31ms |
| Relaunch `/players` | 2267ms | 27ms |
| Relaunch `/trades` | 2268ms | 31ms |
| First relaunch after a deploy | full re-download | 19ms |

In-app route changes did not regress: 26-64ms in both builds.

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

Deploy-update path, against two releases whose `__common` hash moved:

| Check | Old worker | New worker |
| --- | --- | --- |
| previous release precaches what it declares | FAIL (declares nothing) | PASS |
| next release precaches its own boot assets | FAIL (declares nothing) | PASS |
| only the activated release keeps caches | PASS | PASS |
| first relaunch after the deploy still mounts | PASS | PASS |
| no reload storm | PASS (3 loads) | PASS (3 loads) |

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
