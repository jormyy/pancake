\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE preview_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9591);
ALTER TABLE preview_fixture ADD COLUMN held uuid,ADD COLUMN preview uuid,ADD COLUMN balances jsonb;
DO $$
DECLARE f record; v_held uuid; v_preview uuid;
BEGIN
  SELECT * INTO f FROM preview_fixture;
  UPDATE public.leagues SET faab_starting_budget=137,trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  UPDATE public.faab_balances SET balance=137 WHERE league_id=f.league_id;
  v_held:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],
    '{}','{}','{}','{}',NULL,NULL,30,5);
  PERFORM public.accept_trade_atomic(v_held,f.member_ids[2]);
  v_preview:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[3],
    '{}','{}','{}','{}',NULL,NULL,50,1);
  UPDATE public.faab_balances SET balance=90 WHERE member_id=f.member_ids[1] AND league_season_id=f.season_id;
  DELETE FROM public.faab_balances WHERE member_id=f.member_ids[3] AND league_season_id=f.season_id;
  UPDATE preview_fixture SET held=v_held,preview=v_preview;
  UPDATE preview_fixture SET balances=(SELECT jsonb_agg(to_jsonb(balance) ORDER BY member_id)
    FROM public.faab_balances balance WHERE league_id=f.league_id);
END;
$$;
CREATE FUNCTION pg_temp.check_preview_balances()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE f record; teams jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.preview_fixture;
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,
    jsonb_build_array(jsonb_build_object('fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[3],'faabAmount',61)));
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(teams->0->'reasons') reason WHERE reason->>'rule'='budget'),'offer preview defers budget enforcement to acceptance');
  PERFORM pg_temp.check_rules(private.read_available_faab_balance(f.league_id,f.season_id,f.member_ids[1])=60,
    'read balance subtracts accepted reservations');
  PERFORM pg_temp.check_rules(private.read_available_faab_balance(f.league_id,f.season_id,f.member_ids[1],f.held)=90,
    'read balance excludes the requested trade reservation');
  PERFORM pg_temp.check_rules(private.read_available_faab_balance(f.league_id,f.season_id,f.member_ids[3])=137,
    'a missing balance uses the league starting budget');
  PERFORM pg_temp.check_rules(f.balances=(SELECT jsonb_agg(to_jsonb(balance) ORDER BY member_id)
    FROM public.faab_balances balance WHERE league_id=f.league_id),
    'previews preserve balance rows and timestamps');
END;
$$;
DO $$ BEGIN
  IF NOT has_schema_privilege('authenticated',pg_my_temp_schema(),'USAGE') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO authenticated',pg_my_temp_schema()::regnamespace);
  END IF;
END; $$;
GRANT SELECT ON preview_fixture TO authenticated;
COMMIT;
BEGIN READ ONLY;
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM preview_fixture),true);
SET LOCAL ROLE authenticated;
\set ON_ERROR_STOP off
DO $$
DECLARE f record; details jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.preview_fixture;
  details:=public.view_trade_details(f.league_id,f.member_ids[1],jsonb_build_object('tradeId',f.preview));
  PERFORM pg_temp.check_rules(current_setting('transaction_read_only')='on','preview runs in a read-only transaction');
  PERFORM pg_temp.check_rules(details->'trade'->>'id'=f.preview::text,'authenticated trade details open');
  PERFORM pg_temp.check_rules(jsonb_array_length(details->'rosterPreview')=2,'trade details include both roster previews');
  PERFORM pg_temp.check_preview_balances();
  RAISE NOTICE '8 read-only preview assertions passed';
END;
$$;
\set preview_sqlstate :SQLSTATE
\set ON_ERROR_STOP on
ROLLBACK;
BEGIN;
DO $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM preview_fixture;
  PERFORM private.validate_trade_rosters(f.preview);
  PERFORM pg_temp.check_rules((SELECT balance=137 FROM public.faab_balances
    WHERE league_season_id=f.season_id AND member_id=f.member_ids[3]),'write validation still ensures missing balances');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid()
    AND relation='public.faab_balances'::regclass AND mode='RowShareLock'),'write validation still locks balance rows');
END;
$$;
SELECT count(*) AS write_checks FROM rules_checks;
ROLLBACK;
BEGIN;
DELETE FROM public.leagues WHERE id=(SELECT league_id FROM preview_fixture);
DELETE FROM auth.users WHERE id=ANY((SELECT user_ids FROM preview_fixture)::uuid[]);
COMMIT;
SELECT set_config('test.preview_sqlstate',:'preview_sqlstate',false);
DO $$ BEGIN
  IF current_setting('test.preview_sqlstate')<>'00000' THEN
    RAISE EXCEPTION 'Read-only preview failed with SQLSTATE %',current_setting('test.preview_sqlstate');
  END IF;
END; $$;
