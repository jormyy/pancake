# PWA, saved content, and reconnects

## Public shell

`app/+html.tsx` and `constants/boot-shell.ts` paint the public frame before app startup.
Signed-out routes use static forms until their live routes become ready.
Saved league identity belongs to the configured project and user.
It does not authorize reads or actions.

`public/sw.js` caches approved same-origin public files.
It excludes API, Auth, Realtime, private responses, and cross-origin images.
The release stamper supplies the public file manifest and content digests.
Installation verifies the complete boot set before activation.
Activation removes older Pancake caches.
Network fallback handles missing or corrupt cache entries.

A first install needs a network connection.
An installed shell can reopen offline, but an unvisited route can lack required assets.
See [release provenance](release-build-provenance.md) for stamped builds and update checks.

## Private saved content

The app stores private screen snapshots separately from the worker's public cache.
Snapshot keys include the actor and relevant league, season, day, settings, or source revision.
Saved data does not establish current membership, lock state, or eligibility.
Sign-out and identity changes clear private caches and fence late replies.

Lineup recovery keeps the selected day's saved rows read-only until required context and domain reads succeed.
Successful roster reads alone do not restore edit authority.
Storage denial or corruption causes a cache miss.
The [loading rules](instant-loading.md) define how retained content and errors appear.

## Offline actions and recovery

Time-sensitive roster and lineup actions require the server.
Drop, waiver Submit, and the optimizer toggle reject offline admission.
Reconnect enables a new explicit action. It does not queue or replay writes.
An online browser signal does not prove server reachability or permission.

Reconnect and foreground events trigger the owning loaders' refresh paths.
Realtime recovery catches missed revisions before saved content becomes fresh.
Hidden screens defer reads until visible.
Dynasty keeps saved rows and the selection while it revalidates the source.
Published source timestamps keep their meaning; a support lookup does not confirm source freshness.

Restore the connection and use Retry if the error remains.
Check [source health](source-monitoring.md) when server data stays stale.

## Updates and push

The document and worker share one release identity.
Worker checks run on foreground return, reconnect, and periodically while visible.
An update waits for a visible online page and for active mutation holds to release.
The live auction holds updates while active.
A long wait shows a notice; it never forces a held reload.
A session marker limits repeated automatic reloads for the same release.
Missing old route files use the same guarded recovery path.

Web Push needs all three VAPID variables in `.env.example`.
Subscription notices, reconnect, controller changes, and foreground return reconcile existing subscriptions.
Missing subscriptions or changed VAPID keys require an explicit Enable action.
Disabled or signed-out intent stays closed.

## Sign-out

Sign-out requests server revocation and then clears local identity under the Auth lock.
If the server request fails, the app reports that only this device's sign-out is confirmed.
Project-scoped logout markers fence saved sessions and late Auth responses across tabs.
If storage rejects every persistent change, durable erasure cannot be guaranteed after process restoration.

## Verification

Use the [browser setup](../tests/e2e/README.md#supported-web-clients) before these checks:

```sh
npm run e2e:browser-pwa-launch
npm run e2e:pwa-update -- --previous=<previous-build> --next=dist
npm run e2e:web-targets
```

The update check requires two complete stamped builds.
Headless WebKit simulates phone sizes, standalone mode, and safe areas.
Physical installation, keyboard placement, status bars, and background suspension need a real iPhone.
