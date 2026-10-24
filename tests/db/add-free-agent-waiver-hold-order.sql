BEGIN;
DO $$
DECLARE
  actor uuid := gen_random_uuid();
  league uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  held uuid := gen_random_uuid();
  owned uuid := gen_random_uuid();
  free uuid := gen_random_uuid();
  roster uuid;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(actor,actor::text||'@example.test','{}');
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size)
  VALUES(league,'Waiver hold order',league::text,actor,'active',1);
  INSERT INTO public.league_members(id,league_id,user_id,team_name) VALUES(member,league,actor,'Manager');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season,league,2192,true);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions)
  SELECT id,'Hold',id::text,'PG',ARRAY['PG'] FROM unnest(ARRAY[held,owned,free]) id;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(league,season,member,owned,'draft') RETURNING id INTO roster;
  INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,clears_at)
  VALUES(league,season,held,now()-interval '1 minute');
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  BEGIN
    PERFORM public.add_free_agent_atomic(member,league,held);
    RAISE EXCEPTION 'A full roster bypasses the waiver hold';
  EXCEPTION WHEN SQLSTATE 'PA002' THEN NULL; END;
  BEGIN
    PERFORM public.drop_and_add_free_agent_atomic(roster,member,league,held);
    RAISE EXCEPTION 'A compound add bypasses the waiver hold';
  EXCEPTION WHEN SQLSTATE 'PA002' THEN NULL; END;
  IF NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=roster)
     OR EXISTS(SELECT 1 FROM public.roster_transactions WHERE member_id=member) THEN
    RAISE EXCEPTION 'A rejected compound add changes the roster or audit history';
  END IF;
  BEGIN
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(league,season,member,held,'free_agent');
    RAISE EXCEPTION 'A direct insert bypasses the waiver hold';
  EXCEPTION WHEN SQLSTATE 'PA002' THEN NULL; END;
  BEGIN
    PERFORM public.add_free_agent_atomic(member,league,free);
    RAISE EXCEPTION 'An unheld player bypasses the roster cap';
  EXCEPTION WHEN SQLSTATE 'PA003' THEN NULL; END;
  UPDATE public.waiver_wire_log SET cleared_at=now() WHERE league_id=league AND player_id=held;
  PERFORM public.drop_and_add_free_agent_atomic(roster,member,league,held);
  IF NOT EXISTS(SELECT 1 FROM public.roster_players WHERE member_id=member AND player_id=held)
     OR EXISTS(SELECT 1 FROM public.roster_players WHERE id=roster) THEN
    RAISE EXCEPTION 'A cleared waiver cannot replace the dropped player';
  END IF;
END;
$$;
ROLLBACK;
