BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  v_players uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  selected date := (now() AT TIME ZONE 'America/New_York')::date + 1;
  payload jsonb;
  tipoff timestamptz := now() + interval '30 seconds';
  token uuid := gen_random_uuid();
  i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9570);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9570,1,selected-1,selected+5);
  DELETE FROM public.lineup_slot_templates WHERE league_id=f.league_id;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count)
    VALUES(f.league_id,'PG',1),(f.league_id,'PF',1),(f.league_id,'C',1),(f.league_id,'UTIL',1);
  FOR i IN 1..5 LOOP
    INSERT INTO public.players(id,sportsdata_id,first_name,last_name,nba_team,position,eligible_positions)
      VALUES(v_players[i],v_players[i]::text,'Auto-set',i::text,CASE WHEN i=4 THEN 'ASP' ELSE 'ASN' END,
        CASE WHEN i IN (1,4) THEN 'PG' WHEN i=2 THEN 'PF' ELSE 'C' END::public.nba_position,
        ARRAY[CASE WHEN i IN (1,4) THEN 'PG' WHEN i=2 THEN 'PF' ELSE 'C' END]);
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,f.member_ids[1],v_players[i],'draft');
  END LOOP;
  payload := jsonb_build_array(
    jsonb_build_object('player_id',v_players[1],'slot_type','PG'),
    jsonb_build_object('player_id',v_players[2],'slot_type','PF'),
    jsonb_build_object('player_id',v_players[3],'slot_type','C'));
  PERFORM public.auto_set_lineup_atomic_unchecked(f.member_ids[1],f.league_id,f.season_id,selected,payload);
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected),
    'an empty eligible slot is filled by a no-game bench player');
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[1],'slot_type','BE'));
  PERFORM public.auto_set_lineup_atomic_unchecked(f.member_ids[1],f.league_id,f.season_id,selected,payload);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected
    AND player_id=v_players[1] AND slot_type='PG'), 'a bench-only proposal cannot empty the current PG slot');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected
    AND player_id=v_players[2] AND slot_type='PF'), 'an omitted no-game PF starter stays');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected),
    'an incomplete proposal keeps all occupied slots');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('autoset-'||f.league_id,9570,1,selected,'ASP','ASO','Scheduled',now()+interval '1 day');
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[4],'slot_type','PG'));
  PERFORM public.auto_set_lineup_atomic_unchecked(f.member_ids[1],f.league_id,f.season_id,selected,payload);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected
    AND player_id=v_players[4] AND slot_type='PG'), 'a playing bench player replaces the no-game starter');
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_atomic_unchecked(%L,%L,%L,%L,%L::jsonb)',
    f.member_ids[1],f.league_id,f.season_id,selected,jsonb_build_array(jsonb_build_object('player_id',v_players[1],'slot_type','PF'))),
    '%not eligible for PF%', 'position eligibility is enforced');
  UPDATE public.nba_games SET game_time=now()-interval '1 minute' WHERE nba_game_id='autoset-'||f.league_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_atomic_unchecked(%L,%L,%L,%L,%L::jsonb)',
    f.member_ids[1],f.league_id,f.season_id,selected,'[]'), '%game has already started%', 'locked starters cannot move');
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[4],'slot_type','PG'));
  PERFORM public.auto_set_lineup_atomic_unchecked(f.member_ids[1],f.league_id,f.season_id,selected,payload);
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected),
    'a locked player stays while unlocked omitted starters are retained');
  INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
    VALUES(f.league_id,f.season_id,f.member_ids[1],true)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
    VALUES(tipoff,selected-1,'running',token,now()+interval '2 minutes');
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[2],'slot_type','PF','expected_active',false));
  PERFORM public.apply_pre_tipoff_lineup(tipoff,token,f.league_id,f.season_id,f.member_ids[1],payload);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected-1
    AND player_id=v_players[2] AND slot_type='PF'), 'pre-tipoff apply accepts an intentional no-game fallback');
  UPDATE public.players SET eligible_positions=ARRAY['PF','C'] WHERE id=v_players[2];
  UPDATE public.players SET position='PF',eligible_positions=ARRAY['PF'] WHERE id=v_players[5];
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[2],'slot_type','PF'),
    jsonb_build_object('player_id',v_players[3],'slot_type','UTIL'));
  PERFORM public.auto_set_lineup_atomic_unchecked(f.member_ids[1],f.league_id,f.season_id,selected+1,payload);
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM public.weekly_lineups WHERE member_id=f.member_ids[1] AND game_date=selected+1),
    'flexible starters can move to make room for an eligible bench fallback');
  UPDATE public.lineup_tipoff_dispatches SET input_revision=input_revision+1 WHERE tipoff_at=tipoff;
  payload := jsonb_build_array(jsonb_build_object('player_id',v_players[2],'slot_type','PF','expected_active',true));
  PERFORM pg_temp.reject_rules(format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L::jsonb)',
    tipoff,token,f.league_id,f.season_id,f.member_ids[1],payload), '%schedule changed%', 'pre-tipoff still retries a vanished active game');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
