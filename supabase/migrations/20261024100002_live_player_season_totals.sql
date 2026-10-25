BEGIN;

SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
LOCK TABLE public.nba_games,public.player_game_stats IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE analytics.player_season_totals (player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,season_year integer NOT NULL,games_played bigint NOT NULL DEFAULT 0,minutes_played numeric NOT NULL DEFAULT 0,minutes_played_count bigint NOT NULL DEFAULT 0,points numeric NOT NULL DEFAULT 0,points_count bigint NOT NULL DEFAULT 0,rebounds numeric NOT NULL DEFAULT 0,rebounds_count bigint NOT NULL DEFAULT 0,offensive_rebounds numeric NOT NULL DEFAULT 0,offensive_rebounds_count bigint NOT NULL DEFAULT 0,defensive_rebounds numeric NOT NULL DEFAULT 0,defensive_rebounds_count bigint NOT NULL DEFAULT 0,assists numeric NOT NULL DEFAULT 0,assists_count bigint NOT NULL DEFAULT 0,steals numeric NOT NULL DEFAULT 0,steals_count bigint NOT NULL DEFAULT 0,blocks numeric NOT NULL DEFAULT 0,blocks_count bigint NOT NULL DEFAULT 0,turnovers numeric NOT NULL DEFAULT 0,turnovers_count bigint NOT NULL DEFAULT 0,personal_fouls numeric NOT NULL DEFAULT 0,personal_fouls_count bigint NOT NULL DEFAULT 0,field_goals_made numeric NOT NULL DEFAULT 0,field_goals_made_count bigint NOT NULL DEFAULT 0,field_goals_attempted numeric NOT NULL DEFAULT 0,field_goals_attempted_count bigint NOT NULL DEFAULT 0,three_pointers_made numeric NOT NULL DEFAULT 0,three_pointers_made_count bigint NOT NULL DEFAULT 0,three_pointers_attempted numeric NOT NULL DEFAULT 0,three_pointers_attempted_count bigint NOT NULL DEFAULT 0,free_throws_made numeric NOT NULL DEFAULT 0,free_throws_made_count bigint NOT NULL DEFAULT 0,free_throws_attempted numeric NOT NULL DEFAULT 0,free_throws_attempted_count bigint NOT NULL DEFAULT 0,plus_minus numeric NOT NULL DEFAULT 0,plus_minus_count bigint NOT NULL DEFAULT 0,double_double bigint NOT NULL DEFAULT 0,triple_double bigint NOT NULL DEFAULT 0,PRIMARY KEY(player_id,season_year));

CREATE INDEX player_season_totals_year ON analytics.player_season_totals(season_year,player_id);

GRANT SELECT ON analytics.player_season_totals TO anon,authenticated,service_role;

INSERT INTO analytics.player_season_totals(player_id,season_year,games_played,minutes_played,minutes_played_count,points,points_count,rebounds,rebounds_count,offensive_rebounds,offensive_rebounds_count,defensive_rebounds,defensive_rebounds_count,assists,assists_count,steals,steals_count,blocks,blocks_count,turnovers,turnovers_count,personal_fouls,personal_fouls_count,field_goals_made,field_goals_made_count,field_goals_attempted,field_goals_attempted_count,three_pointers_made,three_pointers_made_count,three_pointers_attempted,three_pointers_attempted_count,free_throws_made,free_throws_made_count,free_throws_attempted,free_throws_attempted_count,plus_minus,plus_minus_count,double_double,triple_double) SELECT s.player_id,s.season_year,count(*)::bigint AS games_played,
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
      count(*) FILTER(WHERE s.triple_double)::bigint AS triple_double FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id WHERE NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id) GROUP BY s.player_id,s.season_year;

ALTER TABLE public.league_change_hints DROP CONSTRAINT league_change_hints_topic_check, ADD CONSTRAINT league_change_hints_topic_check CHECK(topic IN ('lineup','roster','score','game','stat','inventory','resources'));

CREATE TABLE private.player_stats_hint_pending(league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE);
REVOKE ALL ON private.player_stats_hint_pending FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.emit_player_stats_hint(p_years integer[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO private.player_stats_hint_pending(league_id)
  SELECT league.id FROM public.leagues league
   WHERE league.deleted_at IS NULL AND league.status IN ('active','playoffs')
     AND EXISTS(SELECT 1 FROM public.league_seasons season
       WHERE season.league_id=league.id AND season.is_current AND season.season_year=ANY(p_years))
   ORDER BY league.id
  ON CONFLICT DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION private.flush_player_stats_hints()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_count integer;
BEGIN
  WITH ready AS MATERIALIZED (
    SELECT pending.league_id FROM private.player_stats_hint_pending pending
    WHERE NOT EXISTS(SELECT 1 FROM public.league_change_hints hint
      WHERE hint.league_id=pending.league_id AND hint.topic='score'
        AND hint.updated_at>clock_timestamp()-interval '1 minute')
    ORDER BY pending.league_id LIMIT 1000 FOR UPDATE SKIP LOCKED
  ), emitted AS (
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details,updated_at)
    SELECT ready.league_id,'score',1,NULL,NULL,clock_timestamp() FROM ready
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=NULL,details=NULL,updated_at=clock_timestamp()
    WHERE stored.updated_at<=clock_timestamp()-interval '1 minute'
    RETURNING league_id
  ) DELETE FROM private.player_stats_hint_pending WHERE league_id IN (SELECT league_id FROM emitted);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION private.flush_player_stats_hints() FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('player-stats-hints','* * * * *','SELECT private.flush_player_stats_hints()');

CREATE OR REPLACE FUNCTION private.maintain_player_season_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_player uuid; v_years integer[];
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT n.*,1 AS sign FROM totals_new_rows n';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT o.*,-1 AS sign FROM totals_old_rows o';
  ELSE v_rows := $rows$SELECT n.*,1 AS sign FROM totals_new_rows n LEFT JOIN totals_old_rows o USING(id)
    WHERE o.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
    UNION ALL SELECT o.*,-1 AS sign FROM totals_old_rows o LEFT JOIN totals_new_rows n USING(id)
    WHERE n.id IS NULL OR (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  FOR v_player IN EXECUTE 'SELECT DISTINCT player_id FROM ('||v_rows||') changed ORDER BY player_id' LOOP
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
      WHERE NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
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

CREATE OR REPLACE FUNCTION private.rebuild_game_player_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player uuid;
BEGIN
  IF public.is_regular_season_game_id(OLD.nba_game_id) IS NOT DISTINCT FROM public.is_regular_season_game_id(NEW.nba_game_id) THEN RETURN NEW; END IF;
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
      AND NOT s.did_not_play AND public.is_regular_season_game_id(g.nba_game_id)
    GROUP BY s.player_id,s.season_year;
  END LOOP;
  PERFORM private.emit_player_stats_hint(ARRAY[OLD.season_year,NEW.season_year]);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.lock_deleted_stat_game()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.nba_games WHERE id=OLD.game_id FOR SHARE;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION private.clear_player_season_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  TRUNCATE analytics.player_season_totals;
  PERFORM private.emit_player_stats_hint(ARRAY(SELECT DISTINCT season_year FROM public.league_seasons WHERE is_current));
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_player_search_caches()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION analytics.seed_league_fantasy_avgs(p_league_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION private.emit_player_stats_hint(integer[]) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION private.maintain_player_season_totals() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION private.rebuild_game_player_totals() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION private.lock_deleted_stat_game() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION private.clear_player_season_totals() FROM PUBLIC,anon,authenticated,service_role;

DROP TRIGGER IF EXISTS search_cache_insert ON public.player_game_stats;

DROP TRIGGER IF EXISTS search_cache_update ON public.player_game_stats;

DROP TRIGGER IF EXISTS search_cache_delete ON public.player_game_stats;

DROP TRIGGER IF EXISTS search_cache_truncate ON public.player_game_stats;

DROP TRIGGER IF EXISTS search_cache_insert ON public.nba_games;

DROP TRIGGER IF EXISTS search_cache_update ON public.nba_games;

DROP TRIGGER IF EXISTS search_cache_delete ON public.nba_games;

DROP TRIGGER IF EXISTS search_cache_truncate ON public.nba_games;

DROP TRIGGER IF EXISTS search_cache_insert ON public.leagues;

DROP TRIGGER IF EXISTS search_cache_update ON public.leagues;

DROP TRIGGER IF EXISTS search_cache_delete ON public.leagues;

DROP TRIGGER IF EXISTS search_cache_truncate ON public.leagues;

CREATE TRIGGER live_totals_insert AFTER INSERT ON public.player_game_stats REFERENCING NEW TABLE AS totals_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.maintain_player_season_totals();

CREATE TRIGGER live_totals_update AFTER UPDATE ON public.player_game_stats REFERENCING OLD TABLE AS totals_old_rows NEW TABLE AS totals_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.maintain_player_season_totals();

CREATE TRIGGER live_totals_delete AFTER DELETE ON public.player_game_stats REFERENCING OLD TABLE AS totals_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.maintain_player_season_totals();

CREATE TRIGGER live_totals_truncate AFTER TRUNCATE ON public.player_game_stats FOR EACH STATEMENT EXECUTE FUNCTION private.clear_player_season_totals();

CREATE TRIGGER live_totals_delete_lock BEFORE DELETE ON public.player_game_stats FOR EACH ROW EXECUTE FUNCTION private.lock_deleted_stat_game();

CREATE TRIGGER zz_live_totals_game AFTER UPDATE OF nba_game_id ON public.nba_games FOR EACH ROW EXECUTE FUNCTION private.rebuild_game_player_totals();

ALTER MATERIALIZED VIEW analytics.mv_player_season_averages RENAME TO player_season_averages_retired;

CREATE VIEW analytics.mv_player_season_averages WITH (security_invoker=true) AS SELECT player_id,season_year,games_played,ROUND(points/NULLIF(points_count,0),1) AS avg_points,ROUND(rebounds/NULLIF(rebounds_count,0),1) AS avg_rebounds,ROUND(assists/NULLIF(assists_count,0),1) AS avg_assists,ROUND(steals/NULLIF(steals_count,0),2) AS avg_steals,ROUND(blocks/NULLIF(blocks_count,0),2) AS avg_blocks,ROUND(turnovers/NULLIF(turnovers_count,0),2) AS avg_turnovers,ROUND(three_pointers_made/NULLIF(three_pointers_made_count,0),2) AS avg_three_pointers_made,ROUND(field_goals_made/NULLIF(field_goals_made_count,0),2) AS avg_field_goals_made,ROUND(field_goals_attempted/NULLIF(field_goals_attempted_count,0),2) AS avg_field_goals_attempted,ROUND(free_throws_made/NULLIF(free_throws_made_count,0),2) AS avg_free_throws_made,ROUND(free_throws_attempted/NULLIF(free_throws_attempted_count,0),2) AS avg_free_throws_attempted,ROUND(minutes_played/NULLIF(minutes_played_count,0),1) AS avg_minutes_played,double_double AS double_doubles,triple_double AS triple_doubles FROM analytics.player_season_totals;

CREATE OR REPLACE VIEW public.mv_player_season_averages WITH (security_invoker=true) AS SELECT * FROM analytics.mv_player_season_averages;

DROP MATERIALIZED VIEW analytics.player_season_averages_retired;

ALTER MATERIALIZED VIEW analytics.mv_player_avg_fantasy_points RENAME TO player_fantasy_averages_retired;

CREATE VIEW analytics.mv_player_avg_fantasy_points WITH (security_invoker=true) AS
WITH coefficients AS MATERIALIZED (SELECT id,COALESCE((scoring_settings->>'points')::numeric,0) AS points,COALESCE((scoring_settings->>'rebounds')::numeric,0) AS rebounds,COALESCE((scoring_settings->>'assists')::numeric,0) AS assists,COALESCE((scoring_settings->>'steals')::numeric,0) AS steals,COALESCE((scoring_settings->>'blocks')::numeric,0) AS blocks,COALESCE((scoring_settings->>'turnovers')::numeric,0) AS turnovers,COALESCE((scoring_settings->>'three_pointers_made')::numeric,0) AS three_pointers_made,COALESCE((scoring_settings->>'field_goals_made')::numeric,0) AS field_goals_made,COALESCE((scoring_settings->>'field_goals_attempted')::numeric,0) AS field_goals_attempted,COALESCE((scoring_settings->>'free_throws_made')::numeric,0) AS free_throws_made,COALESCE((scoring_settings->>'free_throws_attempted')::numeric,0) AS free_throws_attempted,scoring_settings->>'double_double' AS double_double,scoring_settings->>'triple_double' AS triple_double FROM public.leagues)
SELECT l.id AS league_id,t.player_id,t.season_year,
CASE WHEN l.points<>round(l.points,2) OR l.rebounds<>round(l.rebounds,2) OR l.assists<>round(l.assists,2) OR l.steals<>round(l.steals,2) OR l.blocks<>round(l.blocks,2) OR l.turnovers<>round(l.turnovers,2) OR l.three_pointers_made<>round(l.three_pointers_made,2) OR l.field_goals_made<>round(l.field_goals_made,2) OR l.field_goals_attempted<>round(l.field_goals_attempted,2) OR l.free_throws_made<>round(l.free_throws_made,2) OR l.free_throws_attempted<>round(l.free_throws_attempted,2) OR (t.double_double>0 AND COALESCE(l.double_double::numeric,0)<>round(COALESCE(l.double_double::numeric,0),2)) OR (t.triple_double>0 AND COALESCE(l.triple_double::numeric,0)<>round(COALESCE(l.triple_double::numeric,0),2)) THEN (
 SELECT round(avg(fp.fantasy_points),2) FROM public.v_fantasy_points fp
 JOIN public.player_game_stats s ON s.id=fp.stat_id AND NOT s.did_not_play
 WHERE fp.league_id=l.id AND fp.player_id=t.player_id AND fp.season_year=t.season_year
) ELSE round((t.points*l.points+t.rebounds*l.rebounds+t.assists*l.assists+t.steals*l.steals+t.blocks*l.blocks+t.turnovers*l.turnovers+t.three_pointers_made*l.three_pointers_made+t.field_goals_made*l.field_goals_made+t.field_goals_attempted*l.field_goals_attempted+t.free_throws_made*l.free_throws_made+t.free_throws_attempted*l.free_throws_attempted+(CASE WHEN t.double_double>0 THEN t.double_double*COALESCE(l.double_double::numeric,0) ELSE 0 END)+(CASE WHEN t.triple_double>0 THEN t.triple_double*COALESCE(l.triple_double::numeric,0) ELSE 0 END))/NULLIF(t.games_played,0),2) END AS avg_fantasy_points
FROM coefficients l CROSS JOIN analytics.player_season_totals t;

CREATE OR REPLACE VIEW public.v_player_avg_fantasy_points WITH (security_invoker=true) AS SELECT fp.league_id,fp.player_id,fp.season_year,fp.avg_fantasy_points FROM analytics.mv_player_avg_fantasy_points fp JOIN public.leagues l ON l.id=fp.league_id;

DROP MATERIALIZED VIEW analytics.player_fantasy_averages_retired;

GRANT SELECT ON analytics.mv_player_season_averages,analytics.mv_player_avg_fantasy_points TO anon,authenticated,service_role;

TRUNCATE analytics.player_avg_fantasy_points_fresh;

SELECT cron.unschedule(jobid) FROM cron.job WHERE command ILIKE '%refresh_player_search_caches%';

COMMIT;
