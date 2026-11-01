# PWA behavior

The PWA uses a public cached shell and private screen snapshots.
This document defines offline actions, reconnects, updates, and push.

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

## Player detail

`app/player/[id].tsx` presents identity, roster status, season averages, the next-game projection, recent games, and league history.
Identity includes team, eligible positions, dynasty rank, and injury status when available.
Age appears before the experience badge when available.
Birthdates drive age on the current Los Angeles date.
Player rows and detail show Rookie and Taxi tags from stored server values.
Taxi appears only when the league has taxi slots; an unknown non-rookie career count shows no Taxi tag.
The existing injury badge carries injury status.
[Roster lifecycle](roster-lifecycle.md#taxi-eligibility-and-trade-plans) defines eligibility and acquisition rules.
Roster status offers a scheduled claim for each available player.
Owned players have Lineup and Drop controls. Players on another roster have no pickup control.
Eligible claims expose IR and taxi destinations in the shared claim form.
Ownership changes only when the scheduled award succeeds.
Actions require server authorization and current roster checks when executed.
Supported writes can wait in the offline queue.

Season averages share one compact stat grid.
A season dropdown appears when multiple seasons are available.
It changes averages and recent games; the next-game projection uses the current season.
The compact projection shows opponent, day, available tipoff time, and projected points.
A live game replaces it with the current game summary.
Provider and update captions stay out of the compact row.
[Source monitoring](source-monitoring.md#projection-readers) defines provider selection and freshness.

Recent games support pagination and show shooting totals and league fantasy points when available.
League history starts collapsed and appears only when transactions exist.
Wide screens place profile statistics beside recent games.
The page reads its complete server view and renders matching saved content immediately.
Read failures show a warning and preserve available content.

## Cache and offline

Each screen reads its server view through the versioned screen cache.
Keys include account, league, member, season, screen, and normalized parameters.
The cache keeps at most 48 entries and 4 MiB of JSON.
Saved content renders before the background version check.
A clean cached screen reopens with zero requests before that check.
A cold screen requests one complete view without a separate version read.
The rookie draft controller also reads the version.
These counts exclude shared authentication, membership, and change-stream setup.
Unchanged versions reuse saved content.
Changed topics invalidate affected views.
Background standings, matchup totals, averages, and trade values publish their own version changes.
Refresh metadata causes no version bump.
Publication hints do not restart the background refresh.
Missing change ranges require a fresh view.
Foreground and reconnect checks use the version endpoint.
Live Home screens add a version recovery check: ten minutes with fresh public data, 20 seconds in stale or database mode.
An unchanged version does not reload the view.
Visible live screens poll public snapshots every 30 seconds; hidden screens stop.
A snapshot older than two minutes shows saved scores with a stale state.
Past-day views and official finals retain stored results.
See [live scores](live-scores.md) for cache behavior and separate phone/worker rollback.
Draft countdowns continue to update local display time.

Account changes clear private views and reject late responses.
League selection clears screen results before changing the selected member.
The service worker continues to cache public assets separately.
Storage denial leaves readable in-memory results.
A cold offline screen cannot invent missing data.
The app shows its offline notice while saved screens remain readable.

Offline API and guarded RPC actions keep their original request IDs.
The queue stores account, league, affected row IDs, and original input.
It stores no bearer token.
Reconnect uses the current matching account and sends actions in order.
A failed replay stays saved and blocks later actions.
The affected row shows Pending.
The shared notice offers Retry.
Immutable queue snapshots keep pending notices current in compiled releases.
Private WebKit checks prove failed replay retains input and retries with the same ID.
Repeated delivery creates one claim.
Accepted trades and awarded waivers appear after one version bump each.
Browser checks also cover league switching, sign-out, and the next account.
Retry preserves the request ID and input.
The database request guard prevents repeated effects.

See [loading checks](instant-loading.md#cache-and-offline) for the focused unit and WebKit recipes.
Browser parity and replay receipts form part of release verification.

## Updates and push

The document and worker share one release identity.
Worker checks run on foreground return, reconnect, and periodically while visible.
An update waits for a visible online page and for active mutation holds to release.
The live auction and open claim, trade, and lineup editors hold updates while active.
Backgrounding an editor keeps its hold. Closing the editor permits a pending update.
Updates never reload a hidden page. Reconnecting retries a failed update check immediately.
A long wait shows a notice; it never forces a held reload.
A session marker limits repeated automatic reloads for the same release.
Missing old route files use the same guarded recovery path.
Reload requests worker activation and waits for the replacement worker to control the page.
A registration without a waiting worker permits a direct reload after its update check.
An explicit idle reply from any shell permits activation. A held reply or timeout blocks activation.
Returning from player details restores the Matchup, Players, and Roster scroll positions.
Positions stay separate for each account, team, matchup date, and player search.

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

## Versions

Each league has one counter in `league_versions`.
One transaction produces one bump per changed league.
Nested calls and writes to several tables share that bump.
Rollback removes all pending work.
An unchanged row produces no bump.
Internal leases, notification delivery, push tokens, and retry timestamps produce no bump.

`league_changes` keeps the last 128 changes per league.
Each entry has a version, topic, scope, and creation time.
Scope lists affected topics and source tables.
It contains no player, bid, or member details.
A transaction with several topics uses `batch`.
Older cursors receive one `catchup` entry.

`GET /version?league=<uuid>&since=<decimal>` returns `{version, changes}`.
Counters use decimal strings to preserve bigint precision.
The route requires a signed-in user and current league membership.
It sends `Cache-Control: private, no-store`.
An unchanged request reads one primary-key row from `league_versions`.
It reads no membership, screen, or change-log table.
That row holds the current allowed user IDs.
Member changes refresh those IDs under the version row lock.
The changed path reads the `(league_id, version)` index in `league_changes`.

Each bump publishes one `version` row on the existing `league_change_hints` stream.
Its `details` array contains the change and its exact version string.
Existing topic hints remain available to consumers that have not moved to screen views.
No second channel is added.

`readLeagueVersion` reads the endpoint and keeps the greatest applied counter.
`compareLeagueVersions` compares exact decimal counters.
`subscribeLeagueVersion` consumes the existing shared stream.
Mount `useLeagueChangeStream` before using that subscription.
`useLeagueVersion` adds initial, foreground, and reconnect reads.
It adds no polling timer.
Repeated or reversed versions produce no notification.
A missed range produces `catchup`.
Cache clearing preserves the counter and sends `catchup`.
Account changes clear counters and reject late replies.
A saved `since` value also prevents a lower reply from replacing applied state.

Run these recipes against a private stack:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-writes.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-coverage.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-reads.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/league-version-concurrency.sql
npx vitest run tests/lib/league-version.test.ts tests/hooks/use-league-version.test.ts tests/lib/league-changes.test.ts tests/hooks/league-change-stream.test.ts
```

Set `PANCAKE_TEST_DB_PORT` when the private database does not use port 59122.
The write recipe includes the draft, transaction, score, roster, and player recipes.
It checks 126 committed operations against the counter, log, and realtime row.
The coverage recipe follows SQL calls from every atomic RPC and each listed worker RPC.
It checks all reachable screen mutations for insert, update, and delete triggers.
It also calls every entry with invalid inputs and proves rollback leaves no pending version.
The read recipe hides the other tables during the unchanged read.
It also checks retention and old cursors.
The concurrency recipe checks two commits and removed-member access.
Negative controls disable a trigger, retain stale access, and accept a reversed client version.
Each control must fail its check.

The source inventory lives in `tests/db/league-version-coverage.sql`.
The transaction checks live in `tests/db/league-version-writes.sql`.
Use those executable inventories when adding a writer.
