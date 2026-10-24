BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); g uuid:=gen_random_uuid(); v_revision bigint;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES(l,'Live stats hint',l::text,u,'active');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(s,l,2096,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(p,'Free','Agent','PG',ARRAY['PG']);
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES(g,'002live-hint',2096,1,current_date,'HNT','OTH','InProgress');
  INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played) VALUES(p,g,2096,1,20,12.5);
  IF NOT EXISTS(SELECT 1 FROM private.player_stats_hint_pending WHERE league_id=l) THEN RAISE EXCEPTION 'Free-agent stats do not queue a league hint'; END IF;
  PERFORM private.flush_player_stats_hints();
  SELECT revision INTO v_revision FROM league_change_hints WHERE league_id=l AND topic='player_stats';
  IF v_revision IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'First visible-stat hint is missing'; END IF;
  UPDATE player_game_stats SET points=21 WHERE player_id=p;
  PERFORM private.flush_player_stats_hints();
  IF (SELECT revision FROM league_change_hints WHERE league_id=l AND topic='player_stats')<>v_revision THEN RAISE EXCEPTION 'Stats hints exceed the minute throttle'; END IF;
  IF NOT EXISTS(SELECT 1 FROM private.player_stats_hint_pending WHERE league_id=l) THEN RAISE EXCEPTION 'Throttle loses the final changed stats'; END IF;
  UPDATE league_change_hints SET updated_at=clock_timestamp()-interval '61 seconds' WHERE league_id=l AND topic='player_stats';
  PERFORM private.flush_player_stats_hints();
  IF (SELECT revision FROM league_change_hints WHERE league_id=l AND topic='player_stats')<>v_revision+1
    OR EXISTS(SELECT 1 FROM private.player_stats_hint_pending WHERE league_id=l) THEN RAISE EXCEPTION 'Final changed stats do not flush after the throttle'; END IF;
  UPDATE nba_games SET status='Final' WHERE id=g;
  UPDATE player_game_stats SET points=22 WHERE player_id=p;
  IF (SELECT avg_points FROM mv_player_season_averages WHERE player_id=p)<>22 THEN RAISE EXCEPTION 'Final-game correction is not live'; END IF;
  IF (SELECT minutes_played FROM analytics.player_season_totals WHERE player_id=p)<>12.5 THEN RAISE EXCEPTION 'Minutes lose precision'; END IF;
  BEGIN
    UPDATE analytics.player_season_totals SET points=999 WHERE player_id=p;
    IF (SELECT avg_points FROM mv_player_season_averages WHERE player_id=p) IS DISTINCT FROM (SELECT round(avg(points),1) FROM player_game_stats WHERE player_id=p AND NOT did_not_play) THEN
      RAISE EXCEPTION 'Totals differ from source stats';
    END IF;
    RAISE EXCEPTION 'Totals parity oracle accepts corrupt data';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Totals differ from source stats' THEN RAISE; END IF;
  END;
  DELETE FROM player_game_stats WHERE player_id=p;
  IF EXISTS(SELECT 1 FROM analytics.player_season_totals WHERE player_id=p) THEN RAISE EXCEPTION 'Deleted last stat leaves stale totals'; END IF;
END;
$$;
ROLLBACK;
