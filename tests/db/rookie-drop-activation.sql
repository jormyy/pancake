BEGIN;
DO $$
DECLARE
  commissioner uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  league uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  old_season uuid := gen_random_uuid();
  draft uuid := gen_random_uuid();
  old_draft uuid := gen_random_uuid();
  first_player uuid := gen_random_uuid();
  second_player uuid := gen_random_uuid();
  moving uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
  FROM unnest(ARRAY[commissioner,manager]) id;
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
  VALUES(league,'Rookie member activation',league::text,commissioner,'drafting',1,2,1);
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(gen_random_uuid(),league,commissioner,'commissioner','Commissioner'),(member,league,manager,'manager','Manager');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
  VALUES(old_season,league,2190,false),(season,league,2191,true);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status,nba_draft_number)
  VALUES(first_player,'Rookie','First','PG',ARRAY['PG'],0,'Out',1),
        (second_player,'Rookie','Second','PG',ARRAY['PG'],0,'Out',1);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(draft,league,season,'snake','completed',false,1),(old_draft,league,old_season,'snake','completed',false,1);
  INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,skipped_at,skip_reason)
  VALUES(draft,1,1,1,member,now(),'No eligible players');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(league,season,member,first_player,'draft'),(league,season,member,second_player,'draft');
  PERFORM set_config('request.jwt.claim.sub',manager::text,true);
  SELECT id INTO moving FROM public.roster_players WHERE player_id=second_player AND league_season_id=season;
  PERFORM public.drop_player_atomic(moving);
  IF (SELECT status FROM public.leagues WHERE id=league) <> 'active' THEN
    RAISE EXCEPTION 'A direct drop does not activate the completed rookie league';
  END IF;
  UPDATE public.leagues SET status='drafting' WHERE id=league;
  UPDATE public.drafts SET status='in_progress' WHERE id=draft;
  SELECT id INTO moving FROM public.roster_players WHERE player_id=first_player AND league_season_id=season;
  PERFORM public.drop_player_atomic(moving);
  IF (SELECT status FROM public.leagues WHERE id=league) <> 'drafting' THEN
    RAISE EXCEPTION 'A direct drop activates an unfinished rookie league';
  END IF;
END;
$$;
ROLLBACK;
