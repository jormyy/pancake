# Trade estimates

The trade editor requests an estimate from `POST /trades/estimate`. The server reads the current league season, scoring, roster depth, team count, FAAB budget, ownership, rankings, production, and projections. It uses the same dynasty engine as the other dynasty tools.

Each request names the exact asset routes. A player or pick appears once. A FAAB amount appears once per sender and receiver. The server rejects assets that the sender no longer owns. Estimates do not replace the trade validity checks.

The engine reports raw sent and received values separately from package, roster-slot, and replacement adjustments. Known pick slots use the recorded draft slot. Unknown slots carry a range. Future picks receive the engine's time discount. Player ranges are sensitivity bands, not statistical confidence intervals or market prices.

Rankings older than 90 days or dated in the future do not contribute. External projections expire after 36 hours; internal projections expire after eight days. The existing projection pipeline controls the season-average fallback. Missing inputs remain visible and do not silently make a player worth zero.

Replacement value uses the five highest-production available players in the current league season. If none are available, a documented estimate uses league size and roster depth. FAAB value uses the budget and available-player production. These are model assumptions that need judgment checks against plausible trades.

The server caches a quote for ten minutes by exact frozen inputs and model version. The quote contains its inputs, calculation, source dates, input hash, and expiry. The editor clears an old estimate when terms, account, league, settings, source events, or expiry change. A late response cannot replace a newer estimate.

Submitting an offer attaches the displayed quote inside the same database transaction. The quote must belong to the sender and match the saved routes, league, and season. A stale or mismatched quote rejects the submission without writing an offer. Retrying an already completed request returns its original offer and quote.

An older client can submit without a quote. The API attempts to create one before submission. If calculation fails, the normal validity checks still apply and the offer records that no estimate is available. A calculation failure never changes assets or bypasses a server rule.

Inbox, sent offers, details, and history show the saved estimate. Opening its source panel loads the frozen calculation. The separate revalue action uses current inputs and leaves the saved record intact. Counters create a new quote for the new terms.

Quotes are read-only to clients. A manager can read their own quotes and quotes attached to trades they may view. Unattached expired quotes are removed after seven days. Attached quotes remain available with trade history.

Focused checks cover exact and reversed accounting, pick slots and discounting, missing sources, stale responses, quote expiry, mismatched terms, retries, account access, counters, and immutable history. Full-season and browser checks also exercise the production API and saved views. Local measurements do not establish a market price or cloud performance.
