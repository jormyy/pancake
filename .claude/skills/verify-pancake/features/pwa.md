# PWA update and offline behavior

The installed app preserves readable content offline and updates without losing an active user action.

## Sub-features

- `pwa-offline` shows offline state and saved content.
- `pwa-reconnect` restores live content after reconnect.
- `pwa-update` moves to a new local release without mixing versions.
- `pwa-held-update` protects an unfinished form or lineup mutation.
- `pwa-standalone` verifies iPhone home-screen lifecycle and safe areas.

## How to get to it (user POV)

- Install the PWA from Safari and launch its home-screen icon.
- Open Home or Roster online, then lose and regain connectivity.
- Keep the app open while a new release becomes available.
- Fill a form while an update waits.

## Driving it with agent-browser

Preconditions:

- Require the release export, registered service worker, and a previously loaded saved view.
- Updates require two distinct verified local builds. Never fetch the hosted production predecessor.

- **Cache.** Open Home and Roster online. Reload and require the seeded identity and content.
- **Offline.** Run `BROWSER set offline on`, then reload. Require the offline banner and the same saved identity. Open a cached tab and confirm readable content.
- **Mutation guard.** While offline, open Lineup or a claim form. Require disabled mutation controls or an explicit reconnect message; compare the unchanged database after reconnect.
- **Reconnect.** Run `BROWSER set offline off`. Require the banner to clear and a fresh response. Confirm the selected day remains correct.
- **Update.** Serve build B at the same local origin after build A is cached. Use the app’s visible update control if offered, then reload. Require build B’s provenance and no missing chunks.
- **Held update.** Enter an unsaved form before offering build B. Require the form to survive until the app permits the update. Verify the resulting saved value after reload.
- **Standalone.** On a real iPhone, install from the local HTTPS origin, launch from Home, background, resume, rotate, and reopen offline. Capture safe areas, keyboard, and push behavior separately.

## Gotchas

- `set viewport` and an iPhone user agent do not create Safari standalone mode.
- The default run supplies one local release. Update and held-update journeys remain unverified until a second build is prepared.
- HTTP loopback works for desktop service workers. A phone needs a reachable secure origin; localhost points to the phone itself.
- Require a fresh uncached fetch to fail after the offline reload; a cached screen alone does not prove disconnection.
- If browser offline emulation resets during reload, use `tools/verify/offline.mjs` with its isolated browser context.
- Always turn offline mode off before subsequent journeys and cleanup.
