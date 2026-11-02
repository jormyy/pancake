-- Canonical SQL source for private.maintain_player_season_totals.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.maintain_player_season_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_player uuid; v_years integer[]; v_final boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM totals_new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM totals_old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM totals_new_rows n FULL JOIN totals_old_rows o USING(id)
    WHERE n.id IS NULL OR o.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT n.*,1 AS sign FROM totals_new_rows n';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT o.*,-1 AS sign FROM totals_old_rows o';
  ELSE v_rows := $rows$SELECT n.*,1 AS sign FROM totals_new_rows n LEFT JOIN totals_old_rows o USING(id)
    WHERE o.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
    UNION ALL SELECT o.*,-1 AS sign FROM totals_old_rows o LEFT JOIN totals_new_rows n USING(id)
    WHERE n.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM ('||v_rows||') changed JOIN public.nba_games game ON game.id=changed.game_id WHERE game.status=''Final'')' INTO v_final;
  IF NOT v_final THEN RETURN NULL; END IF;
  FOR v_player IN EXECUTE 'SELECT DISTINCT player_id FROM ('||v_rows||') changed JOIN public.nba_games game ON game.id=changed.game_id WHERE game.status=''Final'' ORDER BY player_id' LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('player-season-totals:'||v_player::text,0));
  END LOOP;
  EXECUTE format($query$
    WITH changed AS (%s), grouped AS (
      SELECT s.player_id,s.season_year,s.sign,
      count(*)::bigint AS games_played,
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
      FROM changed s JOIN public.nba_games g ON g.id=s.game_id
      WHERE g.status='Final' AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
      GROUP BY s.player_id,s.season_year,s.sign
    ), delta AS (
      SELECT player_id,season_year,sign*games_played AS games_played,sign*minutes_played AS minutes_played,sign*minutes_played_count AS minutes_played_count,sign*points AS points,sign*points_count AS points_count,sign*rebounds AS rebounds,sign*rebounds_count AS rebounds_count,sign*offensive_rebounds AS offensive_rebounds,sign*offensive_rebounds_count AS offensive_rebounds_count,sign*defensive_rebounds AS defensive_rebounds,sign*defensive_rebounds_count AS defensive_rebounds_count,sign*assists AS assists,sign*assists_count AS assists_count,sign*steals AS steals,sign*steals_count AS steals_count,sign*blocks AS blocks,sign*blocks_count AS blocks_count,sign*turnovers AS turnovers,sign*turnovers_count AS turnovers_count,sign*personal_fouls AS personal_fouls,sign*personal_fouls_count AS personal_fouls_count,sign*field_goals_made AS field_goals_made,sign*field_goals_made_count AS field_goals_made_count,sign*field_goals_attempted AS field_goals_attempted,sign*field_goals_attempted_count AS field_goals_attempted_count,sign*three_pointers_made AS three_pointers_made,sign*three_pointers_made_count AS three_pointers_made_count,sign*three_pointers_attempted AS three_pointers_attempted,sign*three_pointers_attempted_count AS three_pointers_attempted_count,sign*free_throws_made AS free_throws_made,sign*free_throws_made_count AS free_throws_made_count,sign*free_throws_attempted AS free_throws_attempted,sign*free_throws_attempted_count AS free_throws_attempted_count,sign*plus_minus AS plus_minus,sign*plus_minus_count AS plus_minus_count,sign*double_double AS double_double,sign*triple_double AS triple_double FROM grouped
    ), combined AS (
      SELECT player_id,season_year,sum(games_played) AS games_played,sum(minutes_played) AS minutes_played,sum(minutes_played_count) AS minutes_played_count,sum(points) AS points,sum(points_count) AS points_count,sum(rebounds) AS rebounds,sum(rebounds_count) AS rebounds_count,sum(offensive_rebounds) AS offensive_rebounds,sum(offensive_rebounds_count) AS offensive_rebounds_count,sum(defensive_rebounds) AS defensive_rebounds,sum(defensive_rebounds_count) AS defensive_rebounds_count,sum(assists) AS assists,sum(assists_count) AS assists_count,sum(steals) AS steals,sum(steals_count) AS steals_count,sum(blocks) AS blocks,sum(blocks_count) AS blocks_count,sum(turnovers) AS turnovers,sum(turnovers_count) AS turnovers_count,sum(personal_fouls) AS personal_fouls,sum(personal_fouls_count) AS personal_fouls_count,sum(field_goals_made) AS field_goals_made,sum(field_goals_made_count) AS field_goals_made_count,sum(field_goals_attempted) AS field_goals_attempted,sum(field_goals_attempted_count) AS field_goals_attempted_count,sum(three_pointers_made) AS three_pointers_made,sum(three_pointers_made_count) AS three_pointers_made_count,sum(three_pointers_attempted) AS three_pointers_attempted,sum(three_pointers_attempted_count) AS three_pointers_attempted_count,sum(free_throws_made) AS free_throws_made,sum(free_throws_made_count) AS free_throws_made_count,sum(free_throws_attempted) AS free_throws_attempted,sum(free_throws_attempted_count) AS free_throws_attempted_count,sum(plus_minus) AS plus_minus,sum(plus_minus_count) AS plus_minus_count,sum(double_double) AS double_double,sum(triple_double) AS triple_double FROM delta GROUP BY player_id,season_year
    )
    INSERT INTO analytics.player_season_totals AS stored(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double)
      SELECT player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double FROM combined
      WHERE games_played<>0 OR (combined.minutes_played,combined.minutes_played_count,combined.points,combined.points_count,combined.rebounds,combined.rebounds_count,combined.offensive_rebounds,combined.offensive_rebounds_count,combined.defensive_rebounds,combined.defensive_rebounds_count,combined.assists,combined.assists_count,combined.steals,combined.steals_count,combined.blocks,combined.blocks_count,combined.turnovers,combined.turnovers_count,combined.personal_fouls,combined.personal_fouls_count,combined.field_goals_made,combined.field_goals_made_count,combined.field_goals_attempted,combined.field_goals_attempted_count,combined.three_pointers_made,combined.three_pointers_made_count,combined.three_pointers_attempted,combined.three_pointers_attempted_count,combined.free_throws_made,combined.free_throws_made_count,combined.free_throws_attempted,combined.free_throws_attempted_count,combined.plus_minus,combined.plus_minus_count,combined.double_double,combined.triple_double) IS DISTINCT FROM (0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0)
      ORDER BY player_id,season_year
    ON CONFLICT(player_id,season_year) DO UPDATE SET
      games_played=stored.games_played+EXCLUDED.games_played,
      minutes_played=stored.minutes_played+EXCLUDED.minutes_played,
      minutes_played_count=stored.minutes_played_count+EXCLUDED.minutes_played_count,
      points=stored.points+EXCLUDED.points,
      points_count=stored.points_count+EXCLUDED.points_count,
      rebounds=stored.rebounds+EXCLUDED.rebounds,
      rebounds_count=stored.rebounds_count+EXCLUDED.rebounds_count,
      offensive_rebounds=stored.offensive_rebounds+EXCLUDED.offensive_rebounds,
      offensive_rebounds_count=stored.offensive_rebounds_count+EXCLUDED.offensive_rebounds_count,
      defensive_rebounds=stored.defensive_rebounds+EXCLUDED.defensive_rebounds,
      defensive_rebounds_count=stored.defensive_rebounds_count+EXCLUDED.defensive_rebounds_count,
      assists=stored.assists+EXCLUDED.assists,
      assists_count=stored.assists_count+EXCLUDED.assists_count,
      steals=stored.steals+EXCLUDED.steals,
      steals_count=stored.steals_count+EXCLUDED.steals_count,
      blocks=stored.blocks+EXCLUDED.blocks,
      blocks_count=stored.blocks_count+EXCLUDED.blocks_count,
      turnovers=stored.turnovers+EXCLUDED.turnovers,
      turnovers_count=stored.turnovers_count+EXCLUDED.turnovers_count,
      personal_fouls=stored.personal_fouls+EXCLUDED.personal_fouls,
      personal_fouls_count=stored.personal_fouls_count+EXCLUDED.personal_fouls_count,
      field_goals_made=stored.field_goals_made+EXCLUDED.field_goals_made,
      field_goals_made_count=stored.field_goals_made_count+EXCLUDED.field_goals_made_count,
      field_goals_attempted=stored.field_goals_attempted+EXCLUDED.field_goals_attempted,
      field_goals_attempted_count=stored.field_goals_attempted_count+EXCLUDED.field_goals_attempted_count,
      three_pointers_made=stored.three_pointers_made+EXCLUDED.three_pointers_made,
      three_pointers_made_count=stored.three_pointers_made_count+EXCLUDED.three_pointers_made_count,
      three_pointers_attempted=stored.three_pointers_attempted+EXCLUDED.three_pointers_attempted,
      three_pointers_attempted_count=stored.three_pointers_attempted_count+EXCLUDED.three_pointers_attempted_count,
      free_throws_made=stored.free_throws_made+EXCLUDED.free_throws_made,
      free_throws_made_count=stored.free_throws_made_count+EXCLUDED.free_throws_made_count,
      free_throws_attempted=stored.free_throws_attempted+EXCLUDED.free_throws_attempted,
      free_throws_attempted_count=stored.free_throws_attempted_count+EXCLUDED.free_throws_attempted_count,
      plus_minus=stored.plus_minus+EXCLUDED.plus_minus,
      plus_minus_count=stored.plus_minus_count+EXCLUDED.plus_minus_count,
      double_double=stored.double_double+EXCLUDED.double_double,
      triple_double=stored.triple_double+EXCLUDED.triple_double
  $query$,v_rows);
  EXECUTE 'SELECT array_agg(DISTINCT season_year) FROM ('||v_rows||') changed' INTO v_years;
  EXECUTE 'DELETE FROM analytics.player_season_totals WHERE games_played=0 AND player_id IN (SELECT player_id FROM ('||v_rows||') changed)';
  PERFORM private.emit_player_stats_hint(v_years);
  RETURN NULL;
END;
$$;
