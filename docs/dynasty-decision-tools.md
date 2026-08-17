# Dynasty decision tools

This document defines the shared value engine for Dynasty Rankings and Trade Analyzer.

## Product rules

- Rankings show 5-Year Points, 3-Year Points, and Rookies & Picks.
- Rankings open on 5-Year Points.
- Each Points tab preserves its published Hashtag order.
- League scoring adds value context. It does not reorder published ranks.
- The engine keeps short-term points separate from long-term dynasty value.
- Trade Analyzer always uses the 5-year outlook.
- Analyzer experiments stay in session memory.
- Make Offer needs an explicit action and confirmation.
- The app does not call a trade won, lost, fair, unfair, approved, or rejected.

## Engine contract

The engine accepts one league context and a bounded asset list. Assets are players, picks,
FAAB, or analyzer-only roster slots.

Every asset result includes these fields:

- One displayed 5-year value.
- Short-term points and long-term value.
- Production, projection, age, health, movement, replacement, package, and slot components.
- Source names and fetch times.
- Confidence and missing inputs.
- Assumptions used by the calculation.

Trade analysis applies the same asset results to routed assets. It reports each team impact.
It also reports package, replacement-player, and roster-slot effects.

## Internal calibration

All values use a 0 to 1000 display scale. The engine rounds only the final display values.

| Component | Weight | Reason |
| --- | ---: | --- |
| Current production | 35% | Current play helps estimate value. |
| Projection | 25% | Projections cover near-term role changes. |
| Source dynasty rank | 25% | Market rank adds a stable long-term prior. |
| Age curve | 15% | Age helps estimate future value. |

Health can reduce a player result by at most 12%. Rank movement can change it by at most 4%.
Missing inputs lower confidence. They do not produce random values.

Pick curves depend on season distance, round, and slot. A known slot returns one value.
An unknown slot returns an early-to-late range and uses its midpoint for calculations.
Uncertainty grows with season distance.

FAAB value uses the league budget and free-agent quality. A full budget cannot exceed the
value of a useful replacement player.

Replacement value uses the weakest active roster value. A two-for-one can add a free-slot
benefit. A package of weak assets receives a bounded penalty when its total tries to pass
one elite asset.

## Data and cache rules

- One RPC batches player, 5-year, 3-year, Rookie, production, and projection data.
- Sync stores 5-year Points, 3-year Points, and Rookie views under separate source keys.
- Unmatched Rookie rows remain visible as source prospects without player links.
- Ranking cache keys include user, member, league, season, and scoring settings.
- Analyzer cache keys also include team count and FAAB budget.
- Offline lookup uses the last complete Analyzer scope for that user, member, and league.
- Tab changes and searches use the loaded snapshot. They make no ranking request.
- Cache shape changes increment the key version.
- Cached content renders before a background refresh.
- Request sequence checks reject older responses.
- Sign-out clears persistent caches.
- League and identity changes select new cache namespaces.
- Dynasty views and the last safe Analyzer snapshot stay readable offline.
- Offer submission stays disabled offline.

## Safe rollout

Hidden legacy rows and request aliases stay for one release. This keeps database-first deployment and rollback safe.
The next cleanup migration removes them after all live clients use forecast views.

## Release proof

The machine-readable record is `docs/dynasty-decision-tools-status.json`.
The feature count can reach 2/2 before the release gates pass.
The goal completes only after the 20-season soak and agent-browser walkthrough pass.
