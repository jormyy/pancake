\set ON_ERROR_STOP on
\getenv notif_gate_db SUPABASE_DB_URL
\getenv notif_gate_port PANCAKE_TEST_DB_PORT
\if :{?notif_gate_db}
\else
  DO $$ BEGIN RAISE EXCEPTION 'SUPABASE_DB_URL is required'; END $$;
\endif
\if :{?notif_gate_port}
\else
  \set notif_gate_port 54322
\endif
SELECT set_config('notif.gate_db', :'notif_gate_db',false) \gset
SELECT set_config('notif.gate_port', :'notif_gate_port',false) \gset
DO $$ BEGIN
  IF current_setting('notif.gate_port') !~ '^[0-9]+$' OR current_setting('notif.gate_db') !~
    format('^postgres(ql)?://[^/@]+@(127[.]0[.]0[.]1|localhost):%s/[^?]+([?].*)?$',current_setting('notif.gate_port')) THEN
    RAISE EXCEPTION 'Only the expected loopback database port is allowed';
  END IF;
END $$;
BEGIN;
SELECT set_config('app.supabase_url', 'http://127.0.0.1:1', true);
SELECT set_config('app.edge_internal_token', 'local-trade-gate-test', true);
CREATE FUNCTION pg_temp.assert_trade_dispatch(p_label text, p_expected boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_before bigint; v_command text; v_after bigint;
BEGIN
  SELECT count(*) INTO v_before FROM public.edge_invocations WHERE function_name='process-trades';
  SELECT command INTO STRICT v_command FROM cron.job WHERE jobname='nba-process-trades';
  EXECUTE v_command;
  SELECT count(*) INTO v_after FROM public.edge_invocations WHERE function_name='process-trades';
  IF (v_after > v_before) IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION '%: expected dispatch %, got %',p_label,p_expected,v_after-v_before;
  END IF;
END $$;
SELECT pg_temp.assert_trade_dispatch('idle scheduler',false);
DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_other_user uuid := gen_random_uuid();
  v_league uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid();
  v_member uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_trade uuid := gen_random_uuid();
  v_notice uuid;
  v_claim uuid;
  v_suppressed integer;
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now()),
    (v_other_user,'authenticated','authenticated',v_other_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status)
  VALUES(v_league,'Trade gate',v_league::text,v_user,'active');
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(v_member,v_league,v_user,'commissioner','Gate');
  INSERT INTO public.league_members(id,league_id,user_id,role,team_name)
  VALUES(v_other,v_league,v_other_user,'manager','Other');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2111,true);
  INSERT INTO public.trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,expires_at)
  VALUES(v_trade,v_league,v_season,v_member,v_other,now()+interval '1 second');
  PERFORM pg_temp.assert_trade_dispatch('future offer',false);
  UPDATE public.trades SET expires_at=now()-interval '1 second' WHERE id=v_trade;
  PERFORM pg_temp.assert_trade_dispatch('expired offer',true);
  PERFORM public.expire_pending_trades_atomic(50);
  PERFORM pg_temp.assert_trade_dispatch('expired offer drained',false);
  UPDATE public.trades SET status='accepted',veto_window_expires_at=now()+interval '1 second' WHERE id=v_trade;
  PERFORM pg_temp.assert_trade_dispatch('future accepted trade',false);
  UPDATE public.trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=v_trade;
  PERFORM pg_temp.assert_trade_dispatch('due accepted trade',true);
  UPDATE public.league_seasons SET is_current=false WHERE id=v_season;
  PERFORM pg_temp.assert_trade_dispatch('old season accepted trade',false);
  UPDATE public.league_seasons SET is_current=true WHERE id=v_season;
  UPDATE public.leagues SET status='setup' WHERE id=v_league;
  PERFORM pg_temp.assert_trade_dispatch('setup accepted trade',false);
  UPDATE public.trades SET status='pending',expires_at=now()+interval '1 day' WHERE id=v_trade;
  UPDATE public.leagues SET status='offseason' WHERE id=v_league;
  UPDATE public.trades SET status='accepted' WHERE id=v_trade;
  PERFORM pg_temp.assert_trade_dispatch('offseason due trade',true);
  UPDATE public.trades SET status='completed' WHERE id=v_trade;
  PERFORM pg_temp.assert_trade_dispatch('completed trade alerts',true);
  PERFORM public.claim_notification_outbox_atomic(100,60);
  SELECT count(*) INTO v_suppressed FROM public.notification_outbox
  WHERE event_type='league_trade' AND data->>'tradeId'=v_trade::text
    AND member_id IN (v_member,v_other) AND suppressed_at IS NOT NULL
    AND suppression_reason='preferences_disabled';
  IF v_suppressed <> 2 THEN
    RAISE EXCEPTION 'Expected two suppressed fixture trade alerts, got %',v_suppressed;
  END IF;
  PERFORM pg_temp.assert_trade_dispatch('suppressed trade alerts',false);
  INSERT INTO public.notification_outbox(dedupe_key,member_id,event_type,title,body,category,available_at)
  VALUES(v_trade::text,v_member,'matchup_final','Final','Final','activity',now()+interval '1 second') RETURNING id INTO v_notice;
  PERFORM pg_temp.assert_trade_dispatch('future activity alert',false);
  UPDATE public.notification_outbox SET available_at=now()-interval '1 second' WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('due activity alert',true);
  SELECT claim_token INTO v_claim FROM public.claim_notification_outbox_atomic(100,60) WHERE id=v_notice;
  IF v_claim IS NULL THEN RAISE EXCEPTION 'Due alert is not claimable'; END IF;
  PERFORM pg_temp.assert_trade_dispatch('active delivery lease',false);
  UPDATE public.notification_outbox SET claimed_at=now()-interval '61 seconds' WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('expired delivery lease',true);
  SELECT claim_token INTO v_claim FROM public.claim_notification_outbox_atomic(100,60) WHERE id=v_notice;
  PERFORM public.fail_notification_outbox_atomic(v_notice,v_claim,'Web push HTTP 503');
  PERFORM pg_temp.assert_trade_dispatch('future web retry',false);
  UPDATE public.notification_outbox SET available_at=now()-interval '1 second' WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('due web retry',true);
  SELECT claim_token INTO v_claim FROM public.claim_notification_outbox_atomic(100,60) WHERE id=v_notice;
  IF v_claim IS NULL THEN RAISE EXCEPTION 'Due web retry is not claimable'; END IF;
  PERFORM pg_temp.assert_trade_dispatch('active web retry lease',false);
  UPDATE public.notification_outbox SET claimed_at=now()-interval '61 seconds' WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('expired web retry lease',true);
  UPDATE public.notification_outbox SET delivered_at=now() WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('delivered web notification',false);
  UPDATE public.notification_outbox SET delivered_at=NULL,dead_lettered_at=now() WHERE id=v_notice;
  PERFORM pg_temp.assert_trade_dispatch('dead letter',false);
END $$;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.invoke_process_trades_if_due();
  EXCEPTION WHEN insufficient_privilege THEN RETURN; END;
  RAISE EXCEPTION 'Anonymous caller dispatched internal work';
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.invoke_process_trades_if_due();
  EXCEPTION WHEN insufficient_privilege THEN RETURN; END;
  RAISE EXCEPTION 'Authenticated caller dispatched internal work';
END $$;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.invoke_process_trades_if_due();
RESET ROLE;
ROLLBACK;
