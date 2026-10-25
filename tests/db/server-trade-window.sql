BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[]; offer uuid; draft uuid; pick uuid; result jsonb; gate bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9520, 'drafting');
  players := ARRAY[gen_random_uuid(),gen_random_uuid()];
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Window',id::text,'PG',ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[n],players[n],'draft' FROM generate_series(1,2) n;
  draft := gen_random_uuid();
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock)
    VALUES(draft,f.league_id,f.season_id,'snake','completed',false);
  offer := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
    ARRAY[players[1]],ARRAY[players[2]],'{}','{}');
  PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' AND veto_window_expires_at>now() FROM trades WHERE id=offer),
    'drafting acceptance starts the veto window');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.process_due_accepted_trades_atomic(50)),
    'drafting trade waits for veto window');
  UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=offer;
  PERFORM set_config('app.supabase_url','http://127.0.0.1:1',true);
  PERFORM set_config('app.edge_internal_token','local-database-ci-token',true);
  SELECT count(*) INTO gate FROM edge_invocations WHERE function_name='process-trades';
  PERFORM public.invoke_process_trades_if_due();
  PERFORM pg_temp.check_rules((SELECT count(*)>gate FROM edge_invocations WHERE function_name='process-trades'),
    'drafting due trade dispatches the worker');
  PERFORM public.process_due_accepted_trades_atomic(50);
  PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=offer), 'drafting trade settles');
  PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] FROM roster_players WHERE league_season_id=f.season_id AND player_id=players[1]),
    'drafting settlement transfers assets');
  UPDATE leagues SET status='setup' WHERE id=f.league_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L)',
    f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[2]]::text,ARRAY[players[1]]::text,'{}','{}'),
    'Trades open after the startup draft.','setup refuses trade creation');
END;
$$;
DO $$
DECLARE f record; players uuid[]; offer uuid; draft uuid; pick uuid; pending_offer uuid; payload jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9521, 'drafting');
  players := ARRAY[gen_random_uuid(),gen_random_uuid()];
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Live',id::text,'PG',ARRAY['PG'] FROM unnest(players) id;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[n],players[n],'draft' FROM generate_series(1,2) n;
  pick := gen_random_uuid(); draft := gen_random_uuid();
  INSERT INTO draft_picks(id,league_id,original_owner_id,current_owner_id,season_year,round)
    VALUES(pick,f.league_id,f.member_ids[1],f.member_ids[1],9521,1);
  offer := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
    '{}',ARRAY[players[2]],ARRAY[pick],'{}');
  pending_offer:=offer;
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock)
    VALUES(draft,f.league_id,f.season_id,'snake','in_progress',false);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,draft_pick_id)
    VALUES(draft,1,1,1,f.member_ids[1],pick);
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',offer,f.member_ids[2]),
    'Picks in the live draft can be traded after the draft.','live rookie pick refuses acceptance');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L)',
    f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}',ARRAY[players[2]]::text,ARRAY[pick]::text,'{}'),
    'Picks in the live draft can be traded after the draft.','live rookie pick refuses proposal');
  offer := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
    ARRAY[players[1]],ARRAY[players[2]],'{}','{}');
  PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=offer), 'live rookie draft permits player trades');
  UPDATE drafts SET status='cancelled' WHERE id=draft;
  INSERT INTO drafts(league_id,league_season_id,draft_type,status,is_mock)
    VALUES(f.league_id,f.season_id,'auction','in_progress',false);
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',pending_offer,f.member_ids[2]),
    'Trades open after the startup draft.','live startup refuses acceptance');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L,%L,%L,%L)',
    f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[1]]::text,ARRAY[players[2]]::text,'{}','{}'),
    'Trades open after the startup draft.','live startup refuses proposal');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
