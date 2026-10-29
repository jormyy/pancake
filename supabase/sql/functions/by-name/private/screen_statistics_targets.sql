CREATE OR REPLACE FUNCTION private.screen_statistics_targets()
RETURNS regclass[] LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT ARRAY['public.players'::regclass,'public.player_game_stats'::regclass,'public.player_season_averages'::regclass,'analytics.player_season_totals'::regclass,'public.nba_games'::regclass,'public.dynasty_rankings'::regclass,'public.weekly_lineups'::regclass,'public.roster_players'::regclass,'public.matchups'::regclass,'public.matchup_forecasts'::regclass,'private.matchup_forecast_queue'::regclass,'private.forecast_input_revisions'::regclass,'private.forecast_player_history'::regclass,'private.forecast_projection_inputs'::regclass,'private.forecast_season_points'::regclass];
$$;
