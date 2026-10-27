BEGIN;
DO $$
DECLARE
  commissioner uuid := gen_random_uuid();
  manager uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  league uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  old_season uuid := gen_random_uuid();
  draft uuid := gen_random_uuid();
  old_draft uuid := gen_random_uuid();
  first_player uuid := gen_random_uuid();
  second_player uuid := gen_random_uuid();
  third_player uuid := gen_random_uuid();
  moving uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  SELECT id,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now()
  FROM unnest(ARRAY[commissioner,manager,outsider]) id;
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
  VALUES(league,'Rookie member activation',league::text,commissioner,'drafting',1,2,1);
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(gen_random_uuid(),league,commissioner,'commissioner','Commissioner'),(member,league,manager,'manager','Manager');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
  VALUES(old_season,league,2190,false),(season,league,2191,true);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status,nba_draft_number)
  VALUES(first_player,'Rookie','First','PG',ARRAY['PG'],0,'Out',1),
        (second_player,'Rookie','Second','PG',ARRAY['PG'],0,'Out',1),
        (third_player,'Rookie','Third','PG',ARRAY['PG'],0,'Out',1);
  INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(draft,league,season,'snake','completed',false,1),(old_draft,league,old_season,'snake','completed',false,1);
  INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,skipped_at,skip_reason)
  VALUES(draft,1,1,1,member,now(),'No eligible players');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(league,season,member,first_player,'draft'),(league,season,member,second_player,'draft');
  IF public.activate_rookie_draft_league_for_user_atomic(draft,manager) THEN
    RAISE EXCEPTION 'Manager activation ignores an over-cap roster';
  END IF;
  IF public.activate_rookie_draft_league_for_user_atomic(old_draft,manager) THEN
    RAISE EXCEPTION 'Historical draft activates the current league';
  END IF;
  BEGIN
    PERFORM public.activate_rookie_draft_league_for_user_atomic(draft,outsider);
    RAISE EXCEPTION 'Outsider can activate a league';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.activate_rookie_draft_league_for_user_atomic(draft,NULL);
    RAISE EXCEPTION 'A missing actor activates a league';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.leagues SET roster_size=2 WHERE id=league;
  UPDATE public.snake_draft_picks SET skipped_at=NULL,skip_reason=NULL WHERE draft_id=draft;
  IF public.activate_rookie_draft_league_for_user_atomic(draft,manager) THEN
    RAISE EXCEPTION 'Manager activation ignores an unfilled pick';
  END IF;
  UPDATE public.snake_draft_picks SET skipped_at=now(),skip_reason='No eligible players' WHERE draft_id=draft;
  UPDATE public.leagues SET roster_size=1 WHERE id=league;
  SELECT id INTO moving FROM public.roster_players WHERE player_id=second_player AND league_season_id=season;
  BEGIN
    PERFORM set_config('request.jwt.claim.sub',manager::text,true);
    PERFORM public.drop_player_atomic(moving);
    IF (SELECT status FROM leagues WHERE id=league)<>'active' THEN RAISE EXCEPTION 'Direct drop does not activate a ready rookie league'; END IF;
    RAISE EXCEPTION 'Restore direct-drop fixture' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  BEGIN
    UPDATE drafts SET status='in_progress' WHERE id=draft;
    PERFORM set_config('request.jwt.claim.sub',manager::text,true);
    PERFORM public.drop_player_atomic(moving);
    IF (SELECT status FROM leagues WHERE id=league)<>'drafting' THEN RAISE EXCEPTION 'Direct drop activates an unfinished rookie draft'; END IF;
    RAISE EXCEPTION 'Restore unfinished-draft fixture' USING ERRCODE='ZX001';
  EXCEPTION WHEN SQLSTATE 'ZX001' THEN NULL;
  END;
  PERFORM public.toggle_ir_atomic(moving,true,manager);
  IF (SELECT status FROM public.leagues WHERE id=league) <> 'active' THEN
    RAISE EXCEPTION 'The final manager IR move does not activate the league';
  END IF;
  IF public.activate_rookie_draft_league_for_user_atomic(draft,manager) THEN
    RAISE EXCEPTION 'Repeated manager activation is not idempotent';
  END IF;
  UPDATE public.leagues SET status='drafting' WHERE id=league;
  IF NOT public.activate_rookie_draft_league_for_user_atomic(draft,manager) THEN
    RAISE EXCEPTION 'An ordinary member cannot activate a ready league';
  END IF;
  UPDATE public.leagues SET status='drafting',roster_size=2 WHERE id=league;
  INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
  VALUES(pg_current_xact_id(),league,season,member,third_player,'draft',draft);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
  VALUES(league,season,member,third_player,'draft',true) RETURNING id INTO moving;
  PERFORM public.toggle_taxi_atomic(moving,false,manager);
  IF (SELECT status FROM public.leagues WHERE id=league) <> 'active' THEN
    RAISE EXCEPTION 'A manager taxi move does not retry activation';
  END IF;
END;
$$;
ROLLBACK;
