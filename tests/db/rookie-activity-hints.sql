BEGIN;
DO $$
DECLARE
  actor uuid := gen_random_uuid();
  league uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  season uuid := gen_random_uuid();
  activity uuid;
  prior_revision bigint;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(actor,'authenticated','authenticated',actor||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status)
  VALUES(league,'Activity refresh',league::text,actor,'active');
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(member,league,actor,'commissioner','Manager');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current)
  VALUES(season,league,2192,true);
  SELECT COALESCE((SELECT hint.revision FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory'),0) INTO prior_revision;
  INSERT INTO public.league_activity(league_id,league_season_id,actor_member_id,event_type,title,body)
  VALUES(league,season,member,'trade_offered','Trade offered','Offer created') RETURNING id INTO activity;
  IF NOT EXISTS(SELECT 1 FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory' AND hint.revision>prior_revision) THEN
    RAISE EXCEPTION 'New league activity does not publish an inventory hint';
  END IF;
  SELECT hint.revision INTO prior_revision FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory';
  UPDATE public.league_activity SET body='Offer revised' WHERE id=activity;
  IF NOT EXISTS(SELECT 1 FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory' AND hint.revision>prior_revision) THEN
    RAISE EXCEPTION 'Changed league activity does not publish an inventory hint';
  END IF;
  SELECT hint.revision INTO prior_revision FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory';
  DELETE FROM public.league_activity WHERE id=activity;
  IF NOT EXISTS(SELECT 1 FROM public.league_change_hints hint WHERE hint.league_id=league AND topic='inventory' AND hint.revision>prior_revision) THEN
    RAISE EXCEPTION 'Removed league activity does not publish an inventory hint';
  END IF;
END;
$$;
ROLLBACK;
