CREATE OR REPLACE FUNCTION public.get_compact_matchup_forecast_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE value jsonb:=public.get_prepared_matchup_forecast_context(p_matchup_id);
BEGIN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'games') game WHERE COALESCE(game->>'status','') NOT IN ('Final','Cancelled','Postponed')) THEN
    value:=value||jsonb_build_object('roster','[]'::jsonb,'history','[]'::jsonb,'projections','[]'::jsonb,
      'lineups','[]'::jsonb,'templates','[]'::jsonb,'seasonAverages','[]'::jsonb,'previous',NULL);
  END IF;
  RETURN (value-ARRAY['teams','roster','games','history','projections','lineups','templates','seasonAverages','previous'])||jsonb_build_object(
    'wireVersion',1,
    'teams',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'memberId',item->'currentPoints') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'teams') WITH ORDINALITY entries(item,n)),
    'roster',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'member_id',item->'player_id',item->'is_on_ir',item->'is_on_taxi',item->'nba_team',item->'eligible_positions',item->'injury_status') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'roster') WITH ORDINALITY entries(item,n)),
    'games',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'id',item->'game_date',item->'home_team',item->'away_team',item->'status',item->'game_time',item->'started_at',item->'live_scoreboard_elapsed_seconds',item->'live_stats_elapsed_seconds') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'games') WITH ORDINALITY entries(item,n)),
    'history',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'player_id',item->'scores') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'history') WITH ORDINALITY entries(item,n)),
    'projections',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'requested_date',item->'player_id',item->'projection_fantasy_points',item->'projection_source_label',item->'projection_fetched_at',item->'projection_date',item->'projection_is_fresh') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'projections') WITH ORDINALITY entries(item,n)),
    'lineups',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'member_id',item->'player_id',item->'game_date',item->'slot_type',item->'is_auto_set') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'lineups') WITH ORDINALITY entries(item,n)),
    'templates',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'slot_type',item->'slot_count') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'templates') WITH ORDINALITY entries(item,n)),
    'seasonAverages',(SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'player_id',item->'avg_fantasy_points') ORDER BY n),'[]')
      FROM jsonb_array_elements(value->'seasonAverages') WITH ORDINALITY entries(item,n)),
    'previous',CASE WHEN jsonb_typeof(value->'previous')='object' THEN
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(item->'playerId',item->'gameId',item->'projection',item->'source',item->'sourceAt',item->'substituted') ORDER BY n),'[]')
        FROM jsonb_array_elements(COALESCE(value->'previous'->'games','[]')) WITH ORDINALITY entries(item,n))
      ELSE 'null'::jsonb END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_compact_matchup_forecast_context(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_compact_matchup_forecast_context(uuid) TO service_role;
