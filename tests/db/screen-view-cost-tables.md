# Screen read measurements

Postgres uses one CPU and 1 GiB. Each cell uses five samples.
Cold samples restart Postgres. The host file cache stays available.
Nested logging stays disabled during latency measurements.
Function rows count returned JSON responses. Nested rows count each captured statement result.

## Warm reads

| Function | Before p50 / p95 ms | After p50 / p95 ms | Before / after buffers | Rows |
| --- | ---: | ---: | ---: | ---: |
| get_league_version | 0.08 / 0.09 | 0.07 / 0.09 | 2 / 2 | 1 |
| get_prepared_matchup_forecast_context | 27.57 / 30.67 | 10.77 / 12.98 | 6978 / 633 | 1 |
| preview_trade_legality | 21.66 / 70.34 | 20.28 / 20.59 | 1060 / 1060 | 1 |
| view_home | 16.98 / 36.95 | 7.16 / 7.72 | 1015 / 719 | 1 |
| view_league | 0.87 / 2.36 | 0.92 / 1.00 | 47 / 43 | 1 |
| view_lineup | 7.13 / 14.13 | 2.97 / 3.31 | 429 / 283 | 1 |
| view_players | 49.06 / 62.88 | 39.88 / 41.43 | 4240 / 2094 | 1 |
| view_roster | 11.38 / 35.34 | 11.22 / 16.14 | 502 / 485 | 1 |
| view_standings | 0.85 / 2.09 | 0.72 / 0.86 | 39 / 39 | 1 |
| view_trades | 20.81 / 24.18 | 18.87 / 21.73 | 593 / 557 | 1 |

## Cold reads

| Function | Before p50 / p95 ms | After p50 / p95 ms | Before / after buffers | Rows |
| --- | ---: | ---: | ---: | ---: |
| get_league_version | 1.12 / 1.33 | 1.09 / 1.22 | 488 / 488 | 1 |
| get_prepared_matchup_forecast_context | 57.29 / 58.55 | 40.34 / 41.85 | 35712 / 23277 | 1 |
| preview_trade_legality | 30.09 / 56.03 | 28.50 / 28.83 | 5275 / 5112 | 1 |
| view_home | 47.92 / 106.55 | 25.51 / 25.84 | 32285 / 8130 | 1 |
| view_league | 5.77 / 11.19 | 5.54 / 6.21 | 3584 / 3476 | 1 |
| view_lineup | 38.34 / 40.96 | 18.65 / 20.70 | 30451 / 6509 | 1 |
| view_players | 89.86 / 108.60 | 81.90 / 82.66 | 37662 / 28988 | 1 |
| view_roster | 45.15 / 69.17 | 42.67 / 43.70 | 31573 / 25402 | 1 |
| view_standings | 4.88 / 10.64 | 5.06 / 5.60 | 2888 / 2809 | 1 |
| view_trades | 62.44 / 79.97 | 56.06 / 57.58 | 32243 / 26041 | 1 |

## Nested statements

Parent totals include child work. Do not sum them.

### baseline warm, ranked by buffers

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| get_prepared_matchup_forecast_context | private.read_matchup_forecast_context(p_matchup_id) // jsonb_build_object('seasonAverages',COALESCE(( SELECT j | 6633 | 21.79 | 1 |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 3721 | 77.15 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 3376 | 55.94 | 20 |
| view_players |  WITH args AS ( SELECT CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS | 2339 | 18.15 | 20 |
| view_players | jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers, ' | 845 | 14.09 | 1 |

### baseline warm, ranked by milliseconds

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 3721 | 77.15 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 3376 | 55.94 | 20 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 785 | 28.05 | 1 |
| get_prepared_matchup_forecast_context | private.read_matchup_forecast_context(p_matchup_id) // jsonb_build_object('seasonAverages',COALESCE(( SELECT j | 6633 | 21.79 | 1 |
| view_players |  WITH args AS ( SELECT CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS | 2339 | 18.15 | 20 |

### baseline cold, ranked by buffers

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 31162 | 109.55 | 1 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 29685 | 57.97 | 1 |
| view_lineup | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 25105 | 27.54 | 1 |
| view_home | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 25018 | 28.04 | 1 |
| get_prepared_matchup_forecast_context | private.read_matchup_forecast_context(p_matchup_id) // jsonb_build_object('seasonAverages',COALESCE(( SELECT j | 8184 | 22.57 | 1 |

### baseline cold, ranked by milliseconds

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 31162 | 109.55 | 1 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 29685 | 57.97 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 4642 | 48.60 | 20 |
| view_home | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 25018 | 28.04 | 1 |
| view_lineup | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 25105 | 27.54 | 1 |

### final warm, ranked by buffers

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 1713 | 61.34 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 1425 | 36.12 | 20 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 748 | 25.95 | 1 |
| view_players | jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers, ' | 510 | 5.74 | 1 |
| view_players |  WITH args AS ( SELECT CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS | 398 | 6.17 | 20 |

### final warm, ranked by milliseconds

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 1713 | 61.34 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 1425 | 36.12 | 20 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 748 | 25.95 | 1 |
| view_players |  WITH args AS ( SELECT CASE WHEN p_view IN ('today', 'week_avg', 'week_total') THEN p_view ELSE 'today' END AS | 398 | 6.17 | 20 |
| view_players | jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers, ' | 510 | 5.74 | 1 |

### final cold, ranked by buffers

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 23561 | 61.63 | 1 |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 23135 | 90.37 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 2669 | 43.41 | 20 |
| view_players | jsonb_build_object('context', context, 'players', players, 'ownedMap', ownership, 'waiverClearsAt', waivers, ' | 1752 | 8.42 | 1 |
| get_prepared_matchup_forecast_context | private.read_matchup_forecast_context(p_matchup_id) // jsonb_build_object('seasonAverages',COALESCE(( SELECT j | 1734 | 5.87 | 1 |

### final cold, ranked by milliseconds

| Function | Statement prefix | Buffers | ms | Rows |
| --- | --- | ---: | ---: | ---: |
| view_players | SELECT COALESCE(jsonb_agg(to_jsonb(player) // jsonb_build_object('dynasty_rank', (SELECT dynasty_rank FROM pub | 23135 | 90.37 | 1 |
| view_trades | jsonb_build_object('context', context, 'trades', rows, 'hasMore', has_more, 'nextCursor', next_cursor, 'pendin | 23561 | 61.63 | 1 |
| view_players | WITH args AS ( SELECT NULLIF(trim(COALESCE(p_query, '')), '') AS query_text, CASE COALESCE(p_position, 'ALL')  | 2669 | 43.41 | 20 |
| view_home | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 1060 | 8.82 | 1 |
| view_lineup | game_day := public.view_game_day(p_league_id, p_member_id, p_params // jsonb_build_object('date', selected, 'p | 1147 | 8.44 | 1 |

