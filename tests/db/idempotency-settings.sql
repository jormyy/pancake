\ir idempotency-support.sql
DO $$
DECLARE f record; detected boolean := false;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  BEGIN
    PERFORM pg_temp.retry('negative control', f.user_ids[1], format('public.update_league_settings_atomic(%L, %L::jsonb)', f.league_id, '{"trade_veto_window_hours":13}'), 'public.update_league_settings_atomic', true);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'FAIL: negative control: one receipt' THEN RAISE; END IF;
    detected := true;
  END;
  PERFORM pg_temp.check_rules(detected, 'disabled guard fails the receipt test');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM idempotency_test.applications WHERE relation='leagues' GROUP BY request_id HAVING count(*)=2), 'disabled guard applies duplicate writes');
  PERFORM pg_temp.retry('settings', f.user_ids[1], format('public.update_league_settings_atomic(%L, %L::jsonb)', f.league_id, '{"trade_veto_window_hours":12}'), 'public.update_league_settings_atomic');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM idempotency_test.applications a JOIN private.request_receipts r ON r.request_id=a.request_id WHERE r.actor=f.user_ids[1] AND r.function='public.update_league_settings_atomic' AND a.relation='leagues'), 'protected settings apply one write');
  PERFORM pg_temp.retry('configuration', f.user_ids[1], format('public.update_league_configuration_atomic(%L, %L::jsonb)', f.league_id, '{"trade_veto_window_hours":14}'), 'public.update_league_configuration_atomic');
  PERFORM pg_temp.retry('daily optimizer settings', f.user_ids[1], format('public.save_client_settings_atomic(%L,%L::jsonb)','lineup_optimizer',jsonb_build_object('memberId',f.member_ids[1],'leagueId',f.league_id,'seasonId',f.season_id,'enabled',true)), 'public.save_client_settings_atomic');
  PERFORM pg_temp.retry('team settings', f.user_ids[1], format('public.save_client_settings_atomic(%L,%L::jsonb)','team',jsonb_build_object('memberId',f.member_ids[1],'teamName','Saved team')), 'public.save_client_settings_atomic');
  PERFORM pg_temp.retry('notification settings', f.user_ids[1], format('public.save_client_settings_atomic(%L,%L::jsonb)','notifications',jsonb_build_object('userId',f.user_ids[1],'tradeEnabled',false,'waiverEnabled',true,'draftEnabled',true,'activityEnabled',true)), 'public.save_client_settings_atomic');
END;
$$;
\ir idempotency-cleanup.sql
