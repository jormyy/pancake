# Projection calendar lookup

`get_league_projection_rows` selects the next regular-season game once per requested team.
It joins that statement-local result back to each requested player.
The result does not survive the SQL invocation or cache an earlier revision.

The game filter and order remain unchanged: season, date, regular-season ID, team,
then game date, game time with nulls last, and game ID.
Players without a team still have no next game.
Scoring, source priority, provider freshness, DNP averages, pagination and permissions are unchanged.

The local populated profile showed 600 repeated next-game lookups for 30 teams.
Five paired complete caller measurements reduced the 600-player median from 180.26ms to 88.44ms.
Both daily and fallback singleton guards passed.
These are isolated local measurements, not iPhone or production latency claims.

The migration replaces one existing function and requests a PostgREST schema reload.
It adds no table, index, grant, persistent cache or background task.
The function remains SQL, STABLE, security invoker, with the same search path and signature.
The old and new callers are identical and work with either function body.

Recovery restores the previous canonical function statement and reloads the PostgREST schema.
Do not drop the function: replacement preserves its identity, owner, grants and dependencies.
Use a bounded lock timeout and retry a cancelled deployment after its transaction rolls back.
No data migration or historical-stat rewrite is required.
