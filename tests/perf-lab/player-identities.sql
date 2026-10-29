BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  result jsonb;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_id,sleeper_id)
    VALUES(a,'PerfBridge','Person','perf-bridge-nba',NULL),(b,'PerfBridge','Person',NULL,'perf-bridge-sleeper');
  UPDATE public.players SET birthdate=DATE '1990-01-01' WHERE id=b;
  result := public.link_player_sources_atomic('nba',jsonb_build_array(jsonb_build_object(
    'provider_id','perf-bridge-nba','display_name','PerfBridge Person','nba_team','BOS','espn_id','perf-bridge-espn')));
  IF EXISTS(SELECT FROM public.players WHERE id=b) OR NOT EXISTS(
    SELECT FROM public.players WHERE id=a AND nba_id='perf-bridge-nba' AND sleeper_id='perf-bridge-sleeper' AND espn_id='perf-bridge-espn' AND birthdate=DATE '1990-01-01') THEN
    RAISE EXCEPTION 'Complementary null-team source identities stay split';
  END IF;
  DELETE FROM public.players WHERE id=a;
  INSERT INTO public.players(id,first_name,last_name,nba_id,sleeper_id)
    VALUES(a,'PerfBridge','Person','perf-bridge-nba',NULL),(b,'PerfBridge','Person',NULL,'perf-bridge-sleeper');
  PERFORM public.link_player_sources_atomic('nba',jsonb_build_array(jsonb_build_object(
    'provider_id','perf-bridge-nba','display_name','PerfBridge Person','nba_team','BOS')));
  IF NOT EXISTS(SELECT FROM public.players WHERE id=b) THEN RAISE EXCEPTION 'A name alone merges null-team identities'; END IF;
  UPDATE public.players SET birthdate=CASE WHEN id=a THEN DATE '1990-01-01' ELSE DATE '1991-01-01' END WHERE id IN(a,b);
  result := public.link_player_sources_atomic('nba',jsonb_build_array(jsonb_build_object(
    'provider_id','perf-bridge-nba','display_name','PerfBridge Person','nba_team','BOS','espn_id','perf-bridge-espn')));
  IF NOT EXISTS(SELECT FROM public.players WHERE id=b) THEN RAISE EXCEPTION 'Conflicting birthdates merge'; END IF;
  UPDATE public.players SET birthdate=NULL,espn_id=NULL WHERE id IN(a,b);
  INSERT INTO public.players(id,first_name,last_name,sleeper_id) VALUES(c,'PerfBridge','Person','perf-bridge-third');
  result := public.link_player_sources_atomic('nba',jsonb_build_array(jsonb_build_object(
    'provider_id','perf-bridge-nba','display_name','PerfBridge Person','nba_team','BOS','espn_id','perf-bridge-espn')));
  IF (SELECT count(*) FROM public.players WHERE id IN(a,b,c))<>3 THEN RAISE EXCEPTION 'Three-way ambiguity merges'; END IF;
  DELETE FROM public.players WHERE id=c;
  UPDATE public.players SET espn_id='perf-bridge-other-espn' WHERE id=b;
  result := public.link_player_sources_atomic('nba',jsonb_build_array(jsonb_build_object(
    'provider_id','perf-bridge-nba','display_name','PerfBridge Person','nba_team','BOS','espn_id','perf-bridge-espn')));
  IF NOT EXISTS(SELECT FROM public.players WHERE id=b AND espn_id='perf-bridge-other-espn') THEN
    RAISE EXCEPTION 'Conflicting provider identities merge';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'identity bridge: 5 checks PASS';
