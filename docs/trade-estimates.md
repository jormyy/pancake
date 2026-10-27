# Trade estimates

The trade editor requests an estimate from `POST /trades/estimate`. The server reads the current league season, scoring, roster depth, team count, and FAAB budget.
It also reads ownership, rankings, production, and projections. It uses the same dynasty engine as the other dynasty tools.

Each request names the exact asset routes. A player or pick appears once. A FAAB amount appears once per sender and receiver. The server rejects assets that the sender no longer owns. Estimates do not replace the trade validity checks.

The engine reports raw sent and received values separately from package, roster-slot, and replacement adjustments. Known pick slots use the recorded draft slot. Unknown slots carry a range. Future picks receive the engine's time discount. Player ranges are sensitivity bands, not statistical confidence intervals or market prices.

Rankings older than 90 days or dated in the future do not contribute. External projections expire after 36 hours; internal projections expire after eight days. The existing projection pipeline controls the season-average fallback. Missing inputs remain visible and do not silently make a player worth zero.

Replacement value uses the five highest-production available players in the current league season. If none are available, a documented estimate uses league size and roster depth. FAAB value uses the budget and available-player production. These are model assumptions that need judgment checks against plausible trades.

The server caches a quote for ten minutes by exact frozen inputs and model version. The quote contains its inputs, calculation, source dates, input hash, and expiry. The editor clears an old estimate when terms, account, league, settings, source events, or expiry change. A late response cannot replace a newer estimate.

Submitting an offer attaches the displayed quote inside the same database transaction. The quote must belong to the sender and match the saved routes, league, and season. A stale or mismatched quote rejects the submission without writing an offer. Retrying an already completed request returns its original offer and quote.

An older client can submit without a quote. The API attempts to create one before submission. If calculation fails, the normal validity checks still apply and the offer records that no estimate is available. A calculation failure never changes assets or bypasses a server rule.

Inbox, sent offers, details, and history show the saved estimate.
Saved estimate and sources loads the frozen calculation.
Counters create a new quote for the new terms.

## Historical revaluation

Revalue with current inputs requests `POST /trades/:id/revalue` for a saved trade.
The server reads the stored routes and checks the manager's membership and permission to view that trade.
It uses the current league season and current source inputs.
It permits historical assets that change owners or consume picks after settlement.
New estimates and new offers still require current ownership.

Revaluation returns a separate calculation without saving another quote or changing the trade's original estimate.
Its result includes the trade ID, model version, input hash, calculation time, and expiry.
No revaluation changes ownership, FAAB, roster plans, or offer validity.

Quotes are read-only to clients. A manager can read their own quotes and quotes attached to trades they may view. Unattached expired quotes are removed after seven days. Attached quotes remain available with trade history.

## Verification

Run these checks against the isolated migrated database:

```sh
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f tests/db/trade-estimate-snapshots.sql
npm run test:db:trade-historical-revaluation
```

Snapshot checks cover quote expiry, mismatched terms, retries, access, and immutable offer attachments.
Historical checks revalue completed trades after ownership changes and reject unauthorized reads.
They also check that revaluation leaves saved quotes unchanged.
Focused engine and client checks cover accounting, pick values, missing sources, stale responses, and counters.
Use the [verification guide](verification.md) for setup and the [browser guide](../tests/e2e/README.md) for saved views.
Local measurements do not establish a market price or cloud performance.
