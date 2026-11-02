BEGIN;
\ir rules-support.sql
CREATE FUNCTION pg_temp.final_line(p_player uuid,p_game uuid,p_home boolean,p_points int,p_dnp boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('player_id',p_player,'game_id',p_game,'is_home',p_home,'did_not_play',p_dnp,
    'minutes_played',CASE WHEN p_dnp THEN 0 ELSE 10 END,'points',p_points,'rebounds',0,'offensive_rebounds',0,
    'defensive_rebounds',0,'assists',0,'steals',0,'blocks',0,'turnovers',0,'personal_fouls',0,'field_goals_made',0,
    'field_goals_attempted',0,'three_pointers_made',0,'three_pointers_attempted',0,'free_throws_made',0,
    'free_throws_attempted',0,'plus_minus',0,'double_double',false,'triple_double',false);
$$;
DO $$
DECLARE game uuid:=gen_random_uuid(); home uuid:=gen_random_uuid(); missing uuid:=gen_random_uuid(); away uuid:=gen_random_uuid();
  provider text; rows jsonb; before_rows jsonb; rejected boolean:=false;
BEGIN
  provider:='002-final-integrity-'||game;
  INSERT INTO public.players(id,first_name,last_name,nba_id) VALUES(home,'Home','Scorer','99101'),(missing,'Missing','Scorer','99102'),(away,'Away','Scorer','99103');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,home_score,away_score)
    VALUES(game,provider,9566,1,'9566-01-01','BOS','NYK','InProgress',10,8);
  rows:=jsonb_build_array(pg_temp.final_line(home,game,true,10),pg_temp.final_line(missing,game,true,0,true),pg_temp.final_line(away,game,false,8));
  PERFORM public.save_live_game_stats_atomic(game,provider,rows,600);
  SELECT jsonb_agg(to_jsonb(stat) ORDER BY player_id) INTO before_rows FROM public.player_game_stats stat WHERE game_id=game;
  BEGIN
    PERFORM public.save_final_game_unversioned_atomic(game,provider,jsonb_build_array(rows->0,rows->2),12,8,'Final');
  EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
  PERFORM pg_temp.check_rules(rejected,'an unversioned final also rejects incomplete totals');
  PERFORM pg_temp.check_rules((SELECT status='InProgress' AND home_score=10 FROM public.nba_games WHERE id=game),'an unversioned rejection rolls back its score write');
  rejected:=false;
  BEGIN
    PERFORM public.save_final_game_snapshot_atomic(game,provider,jsonb_build_array(rows->0,rows->2),clock_timestamp(),12,8,'Final');
  EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
  PERFORM pg_temp.check_rules(rejected,'incomplete final player totals cannot certify a game');
  PERFORM pg_temp.check_rules((SELECT status='InProgress' AND stats_synced_at IS NULL FROM public.nba_games WHERE id=game),'rejection preserves uncertified game status');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(stat) ORDER BY player_id)=before_rows FROM public.player_game_stats stat WHERE game_id=game),'rejection preserves every earlier player row');
END;
$$;
DO $$
DECLARE game uuid:=gen_random_uuid(); home uuid:=gen_random_uuid(); played uuid:=gen_random_uuid(); away uuid:=gen_random_uuid();
  provider text; rows jsonb; rejected boolean:=false;
BEGIN
  provider:='002-final-participation-'||game;
  INSERT INTO public.players(id,first_name,last_name,nba_id) VALUES(home,'Home','Witness','99111'),(played,'Played','Witness','99112'),(away,'Away','Witness','99113');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,home_score,away_score)
    VALUES(game,provider,9566,1,'9566-01-02','BOS','NYK','InProgress',10,8);
  rows:=jsonb_build_array(pg_temp.final_line(home,game,true,10),pg_temp.final_line(played,game,true,0,true),pg_temp.final_line(away,game,false,8));
  PERFORM public.save_live_game_stats_atomic(game,provider,rows,600);
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-live-holder',gen_random_uuid())::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.record_live_game_participants(%L,%L,ARRAY[%L],clock_timestamp())',game,provider,'99112'),
    'Live poll lease expired or changed','a stale worker cannot record participation');
  PERFORM set_config('request.headers','{}',true);
  PERFORM public.record_live_game_participants(game,provider,ARRAY['99112'],clock_timestamp());
  PERFORM pg_temp.check_rules(public.record_live_game_participants(game,provider,ARRAY['99112'],clock_timestamp())=0,'duplicate participation has no new writes');
  BEGIN
    PERFORM public.save_final_game_snapshot_atomic(game,provider,jsonb_build_array(pg_temp.final_line(home,game,true,12),rows->2),clock_timestamp(),12,8,'Final');
  EXCEPTION WHEN SQLSTATE '22023' THEN rejected:=true; END;
  PERFORM pg_temp.check_rules(rejected,'a balanced final cannot omit a witnessed player');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.live_game_participants WHERE game_id=game AND nba_id='99112'),'failed certification keeps participation evidence');
  rows:=jsonb_build_array(rows->0,pg_temp.final_line(played,game,true,2),rows->2);
  PERFORM public.save_final_game_snapshot_atomic(game,provider,rows,clock_timestamp(),12,8,'Final');
  PERFORM pg_temp.check_rules((SELECT status='Final' AND stats_synced_at IS NOT NULL FROM public.nba_games WHERE id=game),'complete final certifies after retry');
  PERFORM pg_temp.check_rules((SELECT points=2 AND NOT did_not_play FROM public.player_game_stats WHERE game_id=game AND player_id=played),'complete final retains played points');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.live_game_participants WHERE game_id=game),'official stat rows replace temporary participation receipts');
  rows:=jsonb_build_array(pg_temp.final_line(home,game,true,9),pg_temp.final_line(played,game,true,3),rows->2);
  PERFORM public.save_final_game_snapshot_atomic(game,provider,rows,clock_timestamp(),12,8,'Final');
  PERFORM pg_temp.check_rules((SELECT points=3 FROM public.player_game_stats WHERE game_id=game AND player_id=played),'newer complete final corrections remain eligible');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','public.record_live_game_participants(uuid,text,text[],timestamptz)','EXECUTE'),'clients cannot forge participation receipts');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
