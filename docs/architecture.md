# Pancake architecture and data flow

A short map of where each concern lives. Detailed contracts stay in the linked documents.

## Layers

| Layer | Where | Notes |
| --- | --- | --- |
| Web app (iPhone Safari and installed PWA) | `app/`, `components/`, `hooks/`, `lib/` | Expo Router, React Native Web, static export. |
| Boot shell and service worker | `constants/boot-shell.ts`, `app/+html.tsx`, `public/sw.js` | Paints cached chrome before the bundle; caches public build files only. See [pwa-live-data.md](./pwa-live-data.md). |
| API boundary | `supabase/functions/api/` | The single HTTP boundary for mutations that need server logic. Route inventory: [supabase-backend-route-inventory.md](./supabase-backend-route-inventory.md). |
| Database | Postgres via Supabase; `supabase/sql/functions/by-name/` and `supabase/migrations/` | Gameplay mutations run in `SECURITY DEFINER` RPCs that hold the invariants (locks, deadlines, roster limits, taxi rules). |
| Scheduled jobs | `pg_cron` -> `invoke_edge_function` -> Edge functions in `supabase/functions/*` | Wall-clock gates with catch-up; every call is recorded in `edge_invocations` and reconciled every 5 minutes. |
| Shared logic | `core/`, `supabase/shared-src/` | Generated into the app, Edge, and SQL copies; parity tests fail on drift. |

## Startup and auth

1. The boot shell checks the stored session for the configured project and the logout markers, then paints the
   cached league identity for that user only (`constants/boot-shell.ts`).
2. `AuthProvider` (`hooks/use-auth.ts`) reads the stored session (`lib/auth-session.ts`). An expired access token never
   authorizes data reads. While online and visible, a session with a refresh token stays in the loading state until
   the refresh succeeds or the server rejects it, so a reopen does not detour through sign-in.
3. `LeagueProvider` (`contexts/league-context.tsx`) restores the per-user league choice. The choice has no age limit;
   memberships are cached for thirty days and replaced by the server result (`hooks/use-leagues.ts`).
4. Owner changes (sign-out, account switch) clear persistent and registered in-memory caches
   (`lib/persistent-cache.ts`, `lib/session-cache-registry.ts`), and `lib/session-fetch.ts` fences responses
   from a previous owner.

## Caches

| Cache | Where | Invalidation |
| --- | --- | --- |
| Public build files | `public/sw.js` (release-versioned) | New release activation. API, auth and realtime are never intercepted. |
| League choice, memberships | `lib/persistent-cache.ts` (per user) | Sign-out, account change, server membership result. |
| Screen snapshots (home matchup, lineup, player screen, search) | `lib/persistent-cache.ts` (per user, LRU, 24 h) | Focus, realtime, mutation, owner change. |
| Short-lived lookups (current season) | `lib/shared/season.ts` (15 s promise cache) | TTL; commissioner season actions. |

## Live updates

Realtime subscriptions go through `lib/realtime.ts`: one private channel per consumer; `per-watch` gives each table its
own handler and `fallback` sends every watched table to one refresh callback. Consumers supply an `onReconnect` read
to recover changes missed during a socket gap. The adapter waits for rejoin, network access and a visible page. It
skips duplicate initial reads, permits one recovery read in flight, and retries failed recovery twice with backoff.
Disposal cancels retries and resume listeners. Polling, focus, row handling and read ownership stay in the consuming
hooks. Membership and rookie draft event refreshes wait while hidden:

| Consumer | File | Coalescing |
| --- | --- | --- |
| League memberships | `hooks/use-leagues.ts` | 250 ms window, unchanged rows reused. |
| Pending-trade badge | `hooks/use-pending-trade-count.ts` | 250 ms window; authoritative count RPC. |
| Rookie draft room | `hooks/useRookieDraftRoomController.ts` | 250 ms window; 15 s revision poll gated while a reload runs. |
| Home matchup | `hooks/use-matchup-data.ts` | Owner/league/matchup guard on every event; equal lineups keep their reference. |
| Trades screen | `hooks/use-trade-screen-realtime.ts` | Existing debounced feeds. |
| Live box scores | `hooks/use-live-stats.ts` | 15 s while games are live, 60 s otherwise, none while hidden. |

Rankings, memberships, the trade badge and Lineup reuse successful reads for five minutes on focus and visibility
returns. Changes, reconnects and failed reads still require fresh data. Lineup also checks its owner, selected day,
session and league settings before reusing a read.

## Scheduled jobs

`pg_cron` schedules (see migrations) call `public.invoke_edge_function*`, which reads the Edge base URL and internal
token from database settings or Vault and posts through `pg_net`. Edge functions record `sync_runs`; failed or missing
responses are reconciled from `net._http_response` into `edge_invocations`. Job families: trade processing and
notifications (every 5 min), waivers (03:00 ET), live scoring (per minute while games run), schedule, players,
projections, rankings, season boundary, lineup optimizer, retention. Source health and recovery:
[source-monitoring.md](./source-monitoring.md).

## Recent simplification (2026-10)

The app ships web/PWA only, so native-only pieces were removed when nothing referenced them:
`expo-splash-screen` (configured, never imported) and its splash image, `react-native-gesture-handler` (no caller),
an unused 516 KB icon, a byte-identical web tab layout, and a client-side player sorter used only by tests (the server
sorts the full pool before paging). Modal layouts stayed separate because their headers differ, and database helpers
that look dead were left alone because removing them needs a migration and release attestation for little gain.

User-facing surfaces that changed: Players gained a Season filter (current season and the two before it); the Roster
Active band shows its `n/size` count like IR and taxi. Every empty roster, IR, taxi and lineup slot still renders as its
own row on Roster and Matchup. A completely empty Roster keeps its "Browse Players" prompt above those rows instead of
replacing them (`tests/app/roster-empty-slots.test.ts`).


## League change hints

`league_change_hints` stores one revision per league and change topic. Statement triggers group lineup, roster, matchup, game and stat writes. Timestamp-only updates stay quiet. Markers contain scope keys and revisions, never player rows or box scores. A marker includes at most sixteen distinct scopes. Larger batches use a whole-league invalidation; this does not limit league size or discard changes.

The selected league has one shared authenticated subscription. Current membership controls both reads and actual Realtime delivery. Clients cannot insert, update or delete markers. A missed revision broadens the read. Rejoin, account and day changes retain authoritative catch-up and ownership fences. Hidden or offline consumers defer reads. Reads coalesce with a one-second maximum wait, retry failures within a bound, and keep one follow-up after an overlapping change.

Home and the lineup editor use compact lineup and roster hints. Live stats use game and stat hints to read only displayed players. A healthy stream keeps a one-minute safety poll. A disconnected stream retains the fifteen-second live fallback. Existing raw publications remain for other consumers and older clients.

Markers have no cascading foreign key. A league deletion must not publish a deleted marker through the Realtime DELETE path. Existing membership policy denies access after deletion. At most seven small operational rows remain per deleted league; they contain no player stats or league history. Runtime code never deletes these markers. The migration changes no saved settings, history or records and performs no backfill.


Roster, player-support and trade-pick snapshots retain their five-minute age across tab remounts. Their keys include user, member, league, Eastern day and saved league settings. Each read captures the shared stream revision before fetching. A later change, reconnect or session switch makes that snapshot require another read. Cold startup still validates against the server while saved content paints. Inventory hints cover pick ownership, waiver claims/wire/priority, FAAB and season changes. They contain no asset rows. A failed refresh invalidates snapshot freshness. Explicit refresh and reconnect still bypass the age check.


Inventory details name only a resource, season and optional member. Private claim details omit the member. Pick lists include future seasons. Unknown future seasons, overflow, malformed hints and revision gaps require a full read. Narrow details require a contiguous bigint revision after a trusted baseline. Reconnection reads current markers before snapshots become fresh.

The separate `resources` topic covers published averages, projections and scoring settings. Live stat ingestion does not advance it. Daily runtime caches require the current actor, league, ET day, season, player selection and trusted source revision. They expire after five minutes. Changed or failed reads cannot certify freshness. Hidden or offline clients release pending admission and keep invalidation for their next active read.

League panels and player detail gate reads on route focus, document visibility, connectivity and current membership. Saved rows remain display data. Draft joins and player pickup controls revalidate authority before use. Only the selected dirty panel resumes. Late replies cannot replace another actor or suspended resource.

Player support revisions track claims, wire changes and the current member's balance separately from picks and priority. Hidden hints mark the pending read plan immediately. Foreground reads consume that plan once. Search waits for current availability, then joins any source refresh already covered by that read. Failed history pages retain their error and offset during suspension.
