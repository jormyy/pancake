# Server view test changes

Tests use server views and the shared versioned cache.
User-visible behavior keeps direct assertions.

## Removed tests

### tests/hooks/pending-trade-count-coalescing.test.ts

The badge no longer reads counts, polls, or subscribes to trade tables.
It reads the latest owner-scoped screen context.
The replacement tests cover first-frame counts, updates, league changes, account changes, clearing and remounts.

- merges 20 trade and 20 participant events within 100 ms into one count RPC
- queues one follow-up for a burst during a held 500 ms count read
- merges route change and focus during a held count read into one follow-up
- keeps route and focus catch-up when there is no pending read
- shows all 73 incoming offers from the authoritative RPC, without reading a page
- keeps the last count after failure and retries after the existing two-second delay
- limits retries to two, then lets a new focus signal recover the count
- fences old callbacks and held results across account switch and sign-out
- never postpones the window under events every 100 ms for five seconds
- cancels a queued window, removes focus, and rejects callbacks after unmount
- clears retry timers on owner change and unmount
- handles React effect replay and a callback arriving during promise settlement

### tests/components/sidebar-avatar.test.ts

The sidebar no longer contains an avatar or reads profiles.
Profile ownership remains covered by tests/hooks/profile-resource.test.ts.
The sidebar keeps its league, navigation and mounted-route checks.

- shows a committed avatar without reloading the page or rereading the profile
- never renders the old account avatar while the new profile is pending
- does not overwrite a newer committed avatar with the earlier initial read
- ignores failed writes and updates belonging to another account

## Removed client read paths

Server views replace separate reads for matchup lists, league picks, rooms, seasons, slot plans and trade lists.
They also replace estimate requests and saved estimate reads.
Internal helpers remain private when their callers still need them.

## Registered evidence recipes

Package scripts now expose the four screen-cache browser checks, both timeline checks, claims navigation and the full-roster season check.
The timeline fixture server keeps its existing loopback binding.
Database checks use the existing loopback target guards.

### tests/app/lineup-empty-slots.test.ts

Removed: queues a fresh authoritative read when a lineup changes during the initial read.
The shared cache now owns this request ordering.
The existing screen-cache test verifies a write during a cold read causes one authoritative reread.
Lineup tests still verify all configured places, date changes, suspension, locks, league readiness, refresh and visible retry.

Removed: uses the bounded fallback when the initial stream never connects.
The screen no longer waits for the old table stream.
Its replacement verifies the complete view loads without that stream.

### Other obsolete read scheduling checks

- Home: starts the membership-checked announcement RPC without waiting for membership revalidation. Announcements now arrive inside the authorized Home view.
- Roster: refreshes the owner claims list after a local claim mutation. The cache now owns claim invalidation.
- Roster: refreshes an old owner from compact roster hints without repeating initial or unrelated reads. The cache now selects relevant version changes.
- Roster: retries a failed hint read and cancels queued work after leaving the roster. Per-screen hint retry queues no longer exist.
- Rookie controller: binds the first revision to a board read, then skips unchanged and background polls. League versions replace revision polling.

### Draft revision polling

Auction visibility tests now use draft version changes instead of five-second and sixty-second revision probes.
They retain hidden read admission, resume, repeated suspension and teardown checks.
Removed auction case: does not reload the full room after realtime already supplies the polled revision.
League versions replace that revision RPC.

Removed rookie cases:

- queues one follow-up when a slow room read overlaps the 15-second poll
- gates a 20-second revision probe while realtime still processes a pick

These cases count revision probes that no longer run.
The remaining rookie tests retain visible picked-player removal, reset, reconnect, search, expiry, retry and initial paint checks.

### Trade history visits

Replaced: uses one history read per visit when the feed and realtime owner run together.
An unchanged cached version now serves repeated visits without another data read.
The replacement verifies a version change causes one fresh read.

### tests/hooks/league-screen-watches.test.ts

Removed: watches room membership and real draft picks without watching snake pick history.
The screen no longer opens table subscriptions.
Shared league versions invalidate its cached view.
Cache and reconnect tests verify this replacement.

### Home and league view boundaries

Home and league tests now read complete HTTP views through the real cache.
They keep membership, empty-state, date, capacity, reconnect, correction and pagination assertions.
Atomic views replace parallel matchup, lineup and week metadata stitching.
League versions replace table callback routing, safety polls and per-screen persistent cache keys.
The cache owns cold-read sharing and version ordering.
Home retains authorized cached empty answers during membership revalidation.
A failed membership check still shows an error and cannot authorize a read.
History refresh retains the loaded span within the server's 100-row cap.

### Player cards and search

Player cards now arrive in one authorized view.
The replacement checks retain player identity, projections, scoring, local log paging, duplicate games, suspension and retry.
Separate player, season, average, scoring, projection and history request scheduling no longer exists.
Changing season selects a new cache scope and hides the former season until its complete view arrives.
Private cards require the server membership binding.

Search now returns ownership, availability, schedules and totals with its rows.
Tests keep filters, debounce, paging, failed schedules, empty results, ownership changes and reconnect.
The server applies availability before pagination.
Tests send those filters through the HTTP view boundary.
Separate availability admission, automatic-season minute probes and per-row live request throttles no longer run.
The visible-row adapter makes no requests.
Version changes refresh the complete page, including downward corrections and playing status.

### Trade resources

Trade tests retain owner isolation, opaque cursors, duplicate pages, action ordering, saved plans, inherited taxi and reconnect admission.
Complete block views replace separate optional average enrichment reads.
Removed scheduling cases wait for optional averages, compare their request order or write the old persistent cache shape.
The replacement checks retain the previous roster and averages when a complete refresh fails.
Successful mutations remain successful when their following refresh fails.
