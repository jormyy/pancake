CREATE OR REPLACE FUNCTION private.assert_final_player_totals(p_game_id uuid,p_stats jsonb,p_home_score integer,p_away_score integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_home bigint; v_away bigint;
BEGIN
  IF p_home_score IS NULL OR p_away_score IS NULL OR p_home_score<0 OR p_away_score<0
    OR EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) row
      LEFT JOIN public.player_game_stats stored ON stored.game_id=p_game_id AND stored.player_id=row.player_id
      WHERE coalesce(row.is_home,stored.is_home) IS NULL OR row.points IS NULL OR row.points<0 OR row.did_not_play AND row.points<>0) THEN
    RAISE EXCEPTION 'Final player sides and points must be complete.' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(sum(row.points) FILTER(WHERE coalesce(row.is_home,stored.is_home)),0),coalesce(sum(row.points) FILTER(WHERE NOT coalesce(row.is_home,stored.is_home)),0)
    INTO v_home,v_away FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) row
    LEFT JOIN public.player_game_stats stored ON stored.game_id=p_game_id AND stored.player_id=row.player_id;
  IF v_home<>p_home_score OR v_away<>p_away_score THEN
    RAISE EXCEPTION 'Final player points do not match team totals.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM private.live_game_participants witness WHERE witness.game_id=p_game_id
      AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) row
        JOIN public.players player ON player.id=row.player_id
        WHERE player.nba_id=witness.nba_id AND row.did_not_play IS FALSE))
    OR EXISTS(SELECT 1 FROM private.live_feed_state feed,unnest(feed.nba_player_ids) witness
      WHERE feed.game_id=p_game_id AND NOT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats,p_stats) row
        WHERE row.player_id=witness AND row.did_not_play IS FALSE)) THEN
    RAISE EXCEPTION 'Final box score omits witnessed NBA participation.' USING ERRCODE='22023';
  END IF;
END;
$$;
