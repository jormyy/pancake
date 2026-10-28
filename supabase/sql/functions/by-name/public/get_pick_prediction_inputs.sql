CREATE OR REPLACE FUNCTION public.get_pick_prediction_inputs(p_league_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE season public.league_seasons%ROWTYPE; team_count integer; floor_value numeric; result jsonb;
BEGIN
  SELECT * INTO season FROM public.league_seasons WHERE league_id=p_league_id ORDER BY is_current DESC,season_year DESC LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO team_count FROM public.league_members WHERE league_id=p_league_id;
  SELECT LEAST(500,GREATEST(50,180.0*200/GREATEST(1,team_count*roster_size))) INTO floor_value FROM public.leagues WHERE id=p_league_id;
  WITH bands AS MATERIALIZED (
    SELECT * FROM public.get_dynasty_pick_values(p_league_id)
  )
  SELECT jsonb_build_object('leagueId',p_league_id,'seasonYear',season.season_year,
    'sourceVersion',(SELECT content_sha256 FROM private.trade_value_sync_state WHERE id),
    'seasonGames',(SELECT NULLIF(count(*)*2.0/GREATEST(1,team_count),0) FROM public.matchups
      WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_voided),
    'teams',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',member.id,'wins',COALESCE(record.wins,0),'ties',COALESCE(record.ties,0),
      'players',(SELECT COALESCE(jsonb_agg(jsonb_build_object('value',COALESCE(ranking.trade_value,0),'age',ranking.age)),'[]'::jsonb)
        FROM public.roster_players roster LEFT JOIN public.dynasty_rankings ranking
          ON ranking.player_id=roster.player_id AND ranking.source='onenumberhoops.com'
        WHERE roster.member_id=member.id AND roster.league_season_id=season.id)) ORDER BY member.id),'[]'::jsonb)
      FROM public.league_members member LEFT JOIN LATERAL (SELECT wins,ties FROM public.standings
        WHERE member_id=member.id AND league_season_id=season.id ORDER BY week_number DESC LIMIT 1) record ON true
      WHERE member.league_id=p_league_id),
    'games',(SELECT COALESCE(jsonb_agg(jsonb_build_object('home',home_member_id,'away',away_member_id) ORDER BY id),'[]'::jsonb)
      FROM public.matchups WHERE league_season_id=season.id AND matchup_type='regular_season' AND NOT is_finalized AND NOT is_voided),
    'picks',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'draftYear',pick.season_year-1,'round',pick.round,
      'originalOwnerId',pick.original_owner_id,'slot',slot.pick_in_round,
      'bands',(SELECT jsonb_object_agg(value.tier,value.trade_value) FROM (
        SELECT source.tier,COALESCE((SELECT band.trade_value FROM bands band WHERE band.draft_year=source.draft_year AND band.round=source.round AND band.tier=source.tier),CASE WHEN source.round=3 THEN GREATEST(source.trade_value,floor_value) ELSE source.trade_value END) AS trade_value
        FROM public.dynasty_pick_values source WHERE source.round=pick.round AND source.draft_year=(SELECT draft_year FROM public.dynasty_pick_values
          WHERE round=pick.round ORDER BY abs(draft_year-(pick.season_year-1)),draft_year LIMIT 1)
      ) value)) ORDER BY pick.id),'[]'::jsonb) FROM public.draft_picks pick
      LEFT JOIN LATERAL (SELECT pick_in_round FROM public.snake_draft_picks WHERE draft_pick_id=pick.id ORDER BY picked_at DESC NULLS LAST,id LIMIT 1) slot ON true
      WHERE pick.league_id=p_league_id AND pick.round BETWEEN 1 AND 3)) INTO result;
  RETURN result;
END;
$$;
