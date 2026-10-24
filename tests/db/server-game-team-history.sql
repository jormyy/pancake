BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  game uuid := gen_random_uuid();
  home_player uuid := gen_random_uuid();
  away_player uuid := gen_random_uuid();
  rows jsonb;
  changed int;
BEGIN
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
  VALUES(9485,1,'9485-02-01','9485-02-07');
  INSERT INTO public.players(id,first_name,last_name,nba_team)
  VALUES(home_player,'Home','Traded','DEN'),(away_player,'Away','Traded','LAL');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
  VALUES(game,'0029485001',9485,1,'9485-02-02','LAL','BOS','InProgress');
  SELECT jsonb_agg(jsonb_build_object('player_id',player_id,'game_id',game,'season_year',9485,'week_number',1,
    'is_home',is_home,'minutes_played',12,'points',5,'rebounds',1,'offensive_rebounds',0,'defensive_rebounds',1,
    'assists',1,'steals',0,'blocks',0,'turnovers',1,'personal_fouls',1,'field_goals_made',2,'field_goals_attempted',5,
    'three_pointers_made',1,'three_pointers_attempted',2,'free_throws_made',0,'free_throws_attempted',0,
    'plus_minus',0,'double_double',false,'triple_double',false,'did_not_play',false,'updated_at',now())) INTO rows
  FROM (VALUES(home_player,true),(away_player,false)) input(player_id,is_home);
  changed := public.save_live_game_stats_atomic(p_game_id=>game,p_provider_game_id=>'0029485001',p_stats=>rows,p_elapsed_seconds=>720);
  PERFORM pg_temp.check_rules(changed=2, 'live ingest saves both parsed players');
  PERFORM pg_temp.check_rules((SELECT is_home=true FROM public.player_game_stats WHERE player_id=home_player AND game_id=game)
    AND (SELECT is_home=false FROM public.player_game_stats WHERE player_id=away_player AND game_id=game),
    'live ingest stores game sides instead of current NBA teams');
  changed := public.save_game_stats_atomic(p_game_id=>game,p_provider_game_id=>'0029485001',p_stats=>rows,p_is_final=>true);
  PERFORM pg_temp.check_rules(changed=0, 'final ingest preserves identical live team sides without rewriting rows');
  UPDATE public.player_game_stats SET is_home=NULL WHERE game_id=game;
  changed := public.save_game_stats_atomic(p_game_id=>game,p_provider_game_id=>'0029485001',p_stats=>rows,p_is_final=>true);
  PERFORM pg_temp.check_rules(changed=2, 'later imports fill unknown game team sides even when scores are unchanged');
  SELECT jsonb_agg(value-'is_home') INTO rows FROM jsonb_array_elements(rows);
  changed := public.save_game_stats_atomic(p_game_id=>game,p_provider_game_id=>'0029485001',p_stats=>rows,p_is_final=>true);
  PERFORM pg_temp.check_rules(changed=0 AND (SELECT count(*)=2 AND bool_and(is_home IS NOT NULL)
    FROM public.player_game_stats WHERE game_id=game), 'legacy imports preserve known historical team sides');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
