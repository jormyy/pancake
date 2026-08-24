# PWA and live data operations

Pancake keeps the installed shell fast. It keeps live data outside the service worker cache.

## Architecture

1. The release build creates static route files and hashed assets.
2. The service worker handles same-origin documents and static assets.
3. Supabase handles authentication, database reads, and row security.
4. Realtime channels deliver matchup, lineup, draft, and roster changes.
5. Application caches give safe data an immediate first paint.
6. Edge jobs update schedules, players, scores, projections, rankings, and draft order.

See [source monitoring](./source-monitoring.md) for upstream health and recovery.

## Cache policy

| Data | Policy | Invalidation |
| --- | --- | --- |
| App shell | Cache first, then refresh `/` | Every release gets a new cache version. |
| Hashed assets | Stale while revalidate | A new asset URL creates a new entry. |
| Supabase API | Never intercepted | Each request reaches Supabase. |
| Realtime | Never intercepted | The socket reconnects to Supabase. |
| Matchup data | Same-day, user-scoped local cache | Focus, realtime, or reconnect refreshes it. |
| Other screen data | User, league, and resource scoped | TTL, focus, mutation, or sign-out clears it. |

The release cache version contains the commit and a build fingerprint. A same-commit rebuild still creates a new version.

Activation deletes older Pancake caches. The new worker takes control immediately.

The page reloads once after a new worker takes control. The first worker install does not reload the page.

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
npm run e2e:browser-perf
npm run e2e:data-latency
npm run perf:budget -- --require-report --require-data-report
```

The dated evidence lives in [`evidence/2026-08-23-instant-pwa/`](./evidence/2026-08-23-instant-pwa/).

## Known limits

The first install needs one online load before every route asset can enter the cache.

Browser background limits can delay sockets on an idle home-screen app. Foreground and reconnect refreshes correct missed data.

Offline data is a last known snapshot. The error banner marks its uncertain freshness.

Offline writes remain disabled. This avoids invalid moves after a game lock or roster change.
