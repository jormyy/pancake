-- Canonical SQL source for private.rebuild_game_player_totals.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.rebuild_game_player_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player uuid;
BEGIN
  IF (OLD.status='Final')=(NEW.status='Final') AND OLD.season_year=NEW.season_year
    AND public.is_regular_season_game_id(OLD.nba_game_id) IS NOT DISTINCT FROM public.is_regular_season_game_id(NEW.nba_game_id) THEN RETURN NEW; END IF;
  FOR v_player IN SELECT DISTINCT player_id FROM public.player_game_stats WHERE game_id=NEW.id ORDER BY player_id LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('player-season-totals:'||v_player::text,0));
    DELETE FROM analytics.player_season_totals WHERE player_id=v_player AND season_year IN (OLD.season_year,NEW.season_year);
    INSERT INTO analytics.player_season_totals(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double)
    SELECT s.player_id,s.season_year,count(*)::bigint AS games_played,
      COALESCE(sum(s.minutes_played),0) AS minutes_played, count(s.minutes_played)::bigint AS minutes_played_count,
      COALESCE(sum(s.points),0) AS points, count(s.points)::bigint AS points_count,
      COALESCE(sum(s.rebounds),0) AS rebounds, count(s.rebounds)::bigint AS rebounds_count,
      COALESCE(sum(s.offensive_rebounds),0) AS offensive_rebounds, count(s.offensive_rebounds)::bigint AS offensive_rebounds_count,
      COALESCE(sum(s.defensive_rebounds),0) AS defensive_rebounds, count(s.defensive_rebounds)::bigint AS defensive_rebounds_count,
      COALESCE(sum(s.assists),0) AS assists, count(s.assists)::bigint AS assists_count,
      COALESCE(sum(s.steals),0) AS steals, count(s.steals)::bigint AS steals_count,
      COALESCE(sum(s.blocks),0) AS blocks, count(s.blocks)::bigint AS blocks_count,
      COALESCE(sum(s.turnovers),0) AS turnovers, count(s.turnovers)::bigint AS turnovers_count,
      COALESCE(sum(s.personal_fouls),0) AS personal_fouls, count(s.personal_fouls)::bigint AS personal_fouls_count,
      COALESCE(sum(s.field_goals_made),0) AS field_goals_made, count(s.field_goals_made)::bigint AS field_goals_made_count,
      COALESCE(sum(s.field_goals_attempted),0) AS field_goals_attempted, count(s.field_goals_attempted)::bigint AS field_goals_attempted_count,
      COALESCE(sum(s.three_pointers_made),0) AS three_pointers_made, count(s.three_pointers_made)::bigint AS three_pointers_made_count,
      COALESCE(sum(s.three_pointers_attempted),0) AS three_pointers_attempted, count(s.three_pointers_attempted)::bigint AS three_pointers_attempted_count,
      COALESCE(sum(s.free_throws_made),0) AS free_throws_made, count(s.free_throws_made)::bigint AS free_throws_made_count,
      COALESCE(sum(s.free_throws_attempted),0) AS free_throws_attempted, count(s.free_throws_attempted)::bigint AS free_throws_attempted_count,
      COALESCE(sum(s.plus_minus),0) AS plus_minus, count(s.plus_minus)::bigint AS plus_minus_count,
      count(*) FILTER(WHERE s.double_double)::bigint AS double_double,
      count(*) FILTER(WHERE s.triple_double)::bigint AS triple_double
    FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
    WHERE s.player_id=v_player AND s.season_year IN (OLD.season_year,NEW.season_year)
      AND g.status='Final' AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY s.player_id,s.season_year;
  END LOOP;
  PERFORM private.emit_player_stats_hint(ARRAY[OLD.season_year,NEW.season_year]);
  RETURN NEW;
END;
$$;
