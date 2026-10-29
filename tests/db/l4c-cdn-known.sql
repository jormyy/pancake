BEGIN;
DO $$
DECLARE first_id uuid:=gen_random_uuid(); second_id uuid:=gen_random_uuid(); fixture_game_id uuid:=gen_random_uuid(); alias_id uuid;
  records jsonb; receipt jsonb; before_count bigint;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_id) VALUES
    (first_id,'L4cFirst','Known','991234501'),(second_id,'L4cSecond','Known','991234502');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(fixture_game_id,'002-l4c-known',2099,1,'2098-10-25','BOS','NYK','Scheduled');
  INSERT INTO private.player_game_memberships(player_id,game_id,nba_team)
    VALUES(first_id,fixture_game_id,'BOS'),(second_id,fixture_game_id,'NYK');
  records:=jsonb_build_array(
    jsonb_build_object('provider_id','991234501','display_name','L4cFirst Known','nba_game_id','002-l4c-known','nba_team','BOS','identity_only',true),
    jsonb_build_object('provider_id','991234502','display_name','L4cSecond Known','nba_game_id','002-l4c-known','nba_team','NYK','identity_only',true));
  before_count:=pg_stat_get_xact_tuples_updated('private.player_game_memberships'::regclass);
  receipt:=public.resolve_player_imports_atomic('nba_cdn',records);
  IF receipt IS DISTINCT FROM jsonb_build_object('results',jsonb_build_array(
      jsonb_build_object('index',0,'player_id',first_id,'action','updated'),
      jsonb_build_object('index',1,'player_id',second_id,'action','updated')),'stale_draft_numbers_cleared',0)
    OR pg_stat_get_xact_tuples_updated('private.player_game_memberships'::regclass)<>before_count THEN
    RAISE EXCEPTION 'Known CDN identities change their receipt or memberships';
  END IF;
  receipt:=public.resolve_player_imports_atomic('nba_cdn',jsonb_set(records,'{0,nba_team}','"NYK"'));
  IF NOT EXISTS(SELECT FROM private.player_game_memberships m WHERE m.player_id=first_id AND m.game_id=fixture_game_id AND m.nba_team='NYK') THEN
    RAISE EXCEPTION 'Known CDN identities hide a side correction';
  END IF;
  records:=jsonb_set(records,'{0,nba_team}','"NYK"');
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_set(records,'{0,metadata}','{"unsupported":true}'));
    RAISE EXCEPTION 'Known CDN identities skip metadata validation';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_set(records,'{0,nba_game_id}','"002-l4c-missing"'));
    RAISE EXCEPTION 'Known CDN identities skip game validation';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(records->0,records->0));
    RAISE EXCEPTION 'Known CDN identities skip duplicate validation';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  receipt:=public.resolve_player_imports_atomic('nba_cdn',jsonb_set(records,'{0,provider_id}','"991234503"'));
  IF NOT EXISTS(SELECT FROM public.players WHERE nba_id='991234503')
    OR receipt->'results'->0->>'action'<>'inserted' THEN
    RAISE EXCEPTION 'An unknown CDN provider skips insertion';
  END IF;
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-work-key',gen_random_uuid())::text,true);
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',records);
    RAISE EXCEPTION 'Known CDN identities skip a lost work lease';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    IF SQLERRM<>'Work lease is no longer current' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.headers','{}',true);
  SELECT id INTO alias_id FROM public.players WHERE nba_id='196295686';
  IF alias_id IS NULL THEN
    INSERT INTO public.players(first_name,last_name,nba_id) VALUES('L4c','Alias','196295686') RETURNING id INTO alias_id;
  END IF;
  INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(alias_id,fixture_game_id,'BOS');
  BEGIN
    PERFORM public.resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
      'provider_id','196295686','display_name','Wrong Person','nba_game_id','002-l4c-known','nba_team','BOS','identity_only',true)));
    RAISE EXCEPTION 'Known CDN identities skip the Dillon Jones name guard';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
END;
$$;
ROLLBACK;
SELECT 'L4c known CDN identities: 8 checks PASS';
