# Reviewed NBA CDN identity corrections

`resolve_player_imports_atomic` applies a correction only for an exact provider ID and matching player name.
Unknown conflicts still reach the atomic database resolver and fail.
A corrected ID keeps the same player UUID and every historical stat row.
An existing alternate-ID row is repaired in place under the identity lock.
Two existing owners require explicit reconciliation; ingestion never merges or deletes their histories.

The January 21, 2026 box for game `0022500622` lists inactive Dillon Jones as `196295686`.
Thirty-eight later 2025–26 boxes list him as `1641794`.
The January 24 box `0022500643` has the same full name, NYK team, jersey 1, and inactive two-way reason.
The first ID appears only in the January 21 box within the complete regular-season corpus.

Sources:

- https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022500622.json
- https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022500643.json

The simulator's `audit-identities.mjs` records all observations and source SHA-256 values outside the repository.
Its independent final oracle pins this correction to the one affected historical game.
Raw final payloads and every statistical field remain unchanged.
