\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE existing uuid:=gen_random_uuid(); unlinked uuid:=gen_random_uuid(); created uuid; game uuid:=gen_random_uuid(); receipt jsonb; before_row jsonb;
  provider text:='stat-existing-'||existing; new_provider text:='stat-new-'||unlinked;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_id,nba_team,position,eligible_positions,years_exp)
  VALUES(existing,'Stat','Existing',provider,'BOS','G',ARRAY['G'],3),(unlinked,'Stat','New',NULL,'LAL','F',ARRAY['F'],7);
  SELECT to_jsonb(p) INTO before_row FROM public.players p WHERE id=existing;
  receipt:=public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
    'provider_id',provider,'display_name','Changed Name','identity_only',true,'metadata',jsonb_build_object('position','C','years_exp',99))));
  IF (receipt->'results'->0->>'player_id')::uuid IS DISTINCT FROM existing
    OR (SELECT to_jsonb(p) FROM public.players p WHERE id=existing) IS DISTINCT FROM before_row THEN
    RAISE EXCEPTION 'Stat resolution changes an existing player';
  END IF;
  receipt:=public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
    'provider_id',new_provider,'display_name','Stat New','identity_only',true)));
  created:=(receipt->'results'->0->>'player_id')::uuid;
  IF created IS NULL OR created=unlinked OR NOT EXISTS(SELECT FROM public.players WHERE id=created AND nba_id=new_provider)
    OR EXISTS(SELECT FROM public.players WHERE id=unlinked AND nba_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Stat resolution claims an unrelated unkeyed player';
  END IF;
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
  VALUES(game,'002stat-'||game,2027,1,current_date,'BOS','LAL','InProgress');
  PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
    'provider_id',provider,'display_name','Stat Existing','identity_only',true,'nba_game_id','002stat-'||game,'nba_team','BOS')));
  IF NOT EXISTS(SELECT FROM private.player_game_memberships WHERE player_id=existing AND game_id=game AND nba_team='BOS') THEN
    RAISE EXCEPTION 'Stat resolution loses box-side evidence';
  END IF;
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(
      jsonb_build_object('provider_id',provider,'display_name','Stat Existing','identity_only',true),
      jsonb_build_object('provider_id',new_provider,'display_name','Stat New')));
    RAISE EXCEPTION 'Mixed stat and identity records are accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$$;
INSERT INTO public.players(first_name,last_name,nba_id)
SELECT 'Indexed','Stat '||n,'stat-index-'||n FROM generate_series(1,2618) n;
ANALYZE public.players;
SET LOCAL statement_timeout='1s';
DO $$
DECLARE plan jsonb; receipt jsonb; records jsonb; started timestamptz;
BEGIN
  EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM public.players WHERE nba_id='stat-index-1310' INTO plan;
  IF plan::text NOT LIKE '%players_nba_id_key%' OR plan::text LIKE '%LockRows%' THEN
    RAISE EXCEPTION 'Stat identity lookup does not use the unlocked NBA identity index: %',plan;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('provider_id','stat-index-'||n,'display_name','Indexed Stat '||n,'identity_only',true))
  INTO records FROM generate_series(1,500) n;
  started:=clock_timestamp();
  receipt:=public.resolve_player_imports_atomic('nba_cdn',records);
  IF jsonb_array_length(receipt->'results')<>500 OR clock_timestamp()-started>interval '1 second' THEN
    RAISE EXCEPTION 'Stat identity resolution exceeds its result or timing budget';
  END IF;
  RAISE NOTICE 'Indexed lookup: %; 500 stat identities: %',plan,clock_timestamp()-started;
END;
$$;
ROLLBACK;
