BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  target uuid:=gen_random_uuid();
  duplicate uuid:=gen_random_uuid();
  other uuid:=gen_random_uuid();
  receipt jsonb;
  before_updates bigint;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_team,espn_id,nba_id,years_exp,position,eligible_positions)
    VALUES(target,'L4cUnique','Identity','BOS','l4c-espn','l4c-nba',3,'PG',ARRAY['PG']);
  before_updates:=pg_stat_get_xact_tuples_updated('public.players'::regclass);
  receipt:=public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK','years_exp',1,'position','C')));
  IF receipt->'results'->0 IS DISTINCT FROM jsonb_build_object('index',0,'player_id',target,'action','unchanged')
    OR pg_stat_get_xact_tuples_updated('public.players'::regclass)<>before_updates THEN
    RAISE EXCEPTION 'An unchanged linked identity changes its receipt or stored row';
  END IF;
  PERFORM public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK')),true);
  IF (SELECT nba_team FROM public.players WHERE id=target)<>'NYK' THEN
    RAISE EXCEPTION 'The unchanged shortcut hides a current roster move';
  END IF;
  PERFORM public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK','sleeper_id','l4c-sleeper')));
  IF (SELECT sleeper_id FROM public.players WHERE id=target)<>'l4c-sleeper' THEN
    RAISE EXCEPTION 'The unchanged shortcut hides a missing secondary identity';
  END IF;
  UPDATE public.players SET position=NULL,eligible_positions='{}',years_exp=NULL WHERE id=target;
  PERFORM public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK','position','C','years_exp',2)));
  IF NOT EXISTS(SELECT FROM public.players WHERE id=target AND position='C' AND eligible_positions=ARRAY['C'] AND years_exp=2) THEN
    RAISE EXCEPTION 'The unchanged shortcut hides missing metadata';
  END IF;
  receipt:=public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cDifferent Person','nba_team','NYK')));
  IF receipt->'results'->0->>'action'<>'ambiguous' THEN
    RAISE EXCEPTION 'A reused provider identity skips its name guard';
  END IF;
  receipt:=public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK','nba_id','l4c-conflict')));
  IF receipt->'results'->0->>'action'<>'ambiguous' THEN
    RAISE EXCEPTION 'A conflicting secondary identity skips its guard';
  END IF;
  INSERT INTO public.players(id,first_name,last_name,nba_team,sportsdata_id,birthdate)
    VALUES(duplicate,'L4cUnique','Identity','NYK','l4c-duplicate','2000-01-01');
  PERFORM public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK')));
  IF EXISTS(SELECT FROM public.players WHERE id=duplicate)
    OR NOT EXISTS(SELECT FROM public.players WHERE id=target AND sportsdata_id='l4c-duplicate' AND birthdate='2000-01-01') THEN
    RAISE EXCEPTION 'An unchanged primary identity skips a newly discovered merge';
  END IF;
  INSERT INTO public.players(id,first_name,last_name,nba_team,espn_id)
    VALUES(other,'L4cUnique','Identity','NYK','l4c-other');
  receipt:=public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK','espn_id','l4c-other')));
  IF receipt->'results'->0->>'action'<>'ambiguous' OR NOT EXISTS(SELECT FROM public.players WHERE id=other) THEN
    RAISE EXCEPTION 'An unchanged primary identity skips another provider owner';
  END IF;
  DELETE FROM public.players WHERE id=other;
  PERFORM set_config('request.headers',jsonb_build_object('x-pancake-work-key',gen_random_uuid())::text,true);
  BEGIN
    PERFORM public.link_player_sources_atomic('espn',jsonb_build_array(jsonb_build_object(
      'provider_id','l4c-espn','display_name','L4cUnique Identity','nba_team','NYK')));
    RAISE EXCEPTION 'An unchanged source link skips a lost work lease';
  EXCEPTION WHEN SQLSTATE 'PT409' THEN
    IF SQLERRM<>'Work lease is no longer current' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.headers','{}',true);
END;
$$;
ROLLBACK;
SELECT 'L4c source links: 9 checks PASS';
