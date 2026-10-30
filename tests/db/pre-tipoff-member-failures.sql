BEGIN;
\ir rules-support.sql
DO $$
<<test>>
DECLARE
  f record;
  tipoff timestamptz := now() + interval '10 minutes';
  token uuid := gen_random_uuid();
  game_date date := (now() AT TIME ZONE 'America/New_York')::date;
  rpc text := 'public.record_pre_tipoff_lineup_failure(timestamptz,uuid,uuid,uuid,uuid,text)';
  command text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9396);
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('member-failure-'||f.league_id,9396,1,game_date,tipoff,'ZMH','ZMA','Scheduled');
  UPDATE public.lineup_optimizer_settings SET enabled=true WHERE league_id=f.league_id;
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
    VALUES(tipoff,game_date,'queued',token,now()+interval '1 minute');
  PERFORM public.claim_lineup_tipoff_dispatch(tipoff,token);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.get_pending_tipoff_members(tipoff,token)), 'both members initially pending');
  command := format('SELECT public.record_pre_tipoff_lineup_failure(%L,%L,%L,%L,%L,%%L)',tipoff,token,f.league_id,f.season_id,f.member_ids[1]);
  PERFORM pg_temp.reject_rules(format(command,NULL), 'A member failure requires an error.', 'null errors rejected');
  PERFORM pg_temp.reject_rules(format(command,'  '), 'A member failure requires an error.', 'empty errors rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.record_pre_tipoff_lineup_failure(%L,NULL,%L,%L,%L,''failure'')',tipoff,f.league_id,f.season_id,f.member_ids[1]),
    'Tipoff claim is no longer current.', 'null tokens rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.record_pre_tipoff_lineup_failure(%L,%L,%L,%L,%L,''failure'')',tipoff,gen_random_uuid(),f.league_id,f.season_id,f.member_ids[1]),
    'Tipoff claim is no longer current.', 'stale tokens rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.record_pre_tipoff_lineup_failure(%L,%L,%L,%L,%L,''failure'')',tipoff,token,f.league_id,f.season_id,gen_random_uuid()),
    'Optimizer setting not found.', 'unrelated members rejected');
  PERFORM public.record_pre_tipoff_lineup_failure(tipoff,token,f.league_id,f.season_id,f.member_ids[1],repeat('x',5000));
  PERFORM pg_temp.check_rules((SELECT length(error)=4000 AND input_revision=0 FROM public.lineup_tipoff_members WHERE tipoff_at=tipoff AND member_id=f.member_ids[1]), 'bounded member error persisted at current revision');
  PERFORM public.record_pre_tipoff_lineup_failure(tipoff,token,f.league_id,f.season_id,f.member_ids[1],'replacement');
  PERFORM pg_temp.check_rules((SELECT error=repeat('x',4000) FROM public.lineup_tipoff_members WHERE tipoff_at=tipoff AND member_id=f.member_ids[1]), 'failure receipt is idempotent');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 AND bool_and(member_id=f.member_ids[2]) FROM public.get_pending_tipoff_members(tipoff,token)), 'failed member excluded without excluding healthy member');
  PERFORM pg_temp.check_rules(NOT public.apply_pre_tipoff_lineup(tipoff,token,f.league_id,f.season_id,f.member_ids[1],'[]'), 'same revision does not retry member failure');
  PERFORM public.apply_pre_tipoff_lineup(tipoff,token,f.league_id,f.season_id,f.member_ids[2],'[]');
  PERFORM public.record_pre_tipoff_lineup_failure(tipoff,token,f.league_id,f.season_id,f.member_ids[2],'late response failure');
  PERFORM pg_temp.check_rules((SELECT error IS NULL FROM public.lineup_tipoff_members WHERE tipoff_at=tipoff AND member_id=f.member_ids[2]), 'failure cannot overwrite a committed success');
  PERFORM public.finish_lineup_tipoff_dispatch(tipoff,token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' AND error IS NULL FROM public.lineup_tipoff_dispatches WHERE tipoff_at=tipoff), 'member failure permits dispatch success');
  PERFORM pg_temp.reject_rules(format(command,'late failure'), 'Tipoff claim is no longer current.', 'finished dispatch rejects writes');
  token := gen_random_uuid();
  UPDATE public.lineup_tipoff_dispatches SET status='queued',token=test.token,input_revision=1,lease_until=now()+interval '1 minute' WHERE tipoff_at=tipoff;
  PERFORM public.claim_lineup_tipoff_dispatch(tipoff,token);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.get_pending_tipoff_members(tipoff,token)), 'new inputs permit both members to run');
  PERFORM pg_temp.reject_rules(format(command,'previous worker'), 'Tipoff claim is no longer current.', 'new token fences previous worker');
  PERFORM public.record_pre_tipoff_lineup_failure(tipoff,token,f.league_id,f.season_id,f.member_ids[1],'new revision failure');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM public.lineup_tipoff_members WHERE tipoff_at=tipoff AND member_id=f.member_ids[1]), 'failure history retained across revisions');
  UPDATE public.lineup_tipoff_dispatches SET lease_until=clock_timestamp()-interval '1 second' WHERE tipoff_at=tipoff;
  PERFORM pg_temp.reject_rules(format('SELECT public.record_pre_tipoff_lineup_failure(%L,%L,%L,%L,%L,''failure'')',tipoff,token,f.league_id,f.season_id,f.member_ids[1]),
    'Tipoff claim is no longer current.', 'expired leases reject writes');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('anon',rpc,'EXECUTE') AND NOT has_function_privilege('authenticated',rpc,'EXECUTE')
    AND has_function_privilege('service_role',rpc,'EXECUTE'), 'failure RPC is service only');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
