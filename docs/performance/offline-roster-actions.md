# Offline Drop and waiver Submit

Drop and waiver Submit require an online browser connection. Roster and player-page Drop controls and the waiver Submit control use the existing connectivity state and disabled styling. An offline roster long press explains why Drop is unavailable.

The mutation functions also read current browser connectivity at admission. A confirmation opened online cannot send a Drop after the browser reports offline. A stale Submit callback rejects before calling the API. Platforms without a browser offline signal retain their existing server path.

The existing error presentation reports these messages when a callback reaches offline admission:

- `Connect to the internet to drop a player.`
- `Connect to the internet to submit a waiver claim.`

Reconnect enables an explicit action. It does not queue or replay a mutation. A synchronous submission flag prevents duplicate waiver requests before React updates the button. Existing confirmation, full-roster/drop selection, weekly limit, FAAB validation, owner checks, and server authorization remain required. An online signal does not establish server authority or guarantee reachability. Server failures remain visible and need an explicit retry.

No cache, service worker, authentication, RLS, scoring, or mutation payload changes are part of this correction. Other offline actions and full-platform acceptance remain separately accountable. Browser simulations do not establish physical iPhone Safari or installed-PWA behavior.
