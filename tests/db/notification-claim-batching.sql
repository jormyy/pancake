BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE notification_batch_fixture AS
SELECT f.*,gen_random_uuid() AS player_id FROM pg_temp.rules_fixture(2,9591) f;
INSERT INTO notification_preferences(user_id,master_enabled,event_settings)
SELECT user_ids[1],true,'{"lineup_inactive":true,"lineup_empty":true}'::jsonb FROM notification_batch_fixture
ON CONFLICT(user_id) DO UPDATE SET master_enabled=true,event_settings=EXCLUDED.event_settings;
CREATE TEMP TABLE notification_batch_counter(calls integer NOT NULL);
INSERT INTO notification_batch_counter VALUES(0);
ALTER FUNCTION private.notif_lineup_candidates_scoped(timestamptz,uuid,uuid) RENAME TO batch_saved_lineup_candidates;
CREATE FUNCTION private.notif_lineup_candidates_scoped(p_now timestamptz,p_league_id uuid,p_member_id uuid)
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE pg_temp.notification_batch_counter SET calls=calls+1;
  RETURN QUERY SELECT event.kind,f.league_id,f.member_ids[1],f.player_id,DATE '2026-10-29'
  FROM pg_temp.notification_batch_fixture f CROSS JOIN (VALUES('lineup_inactive'::text),('lineup_empty')) event(kind)
  WHERE f.league_id=p_league_id AND f.member_ids[1]=p_member_id;
END;
$$;
DELETE FROM notification_outbox;
INSERT INTO notification_outbox(dedupe_key,member_id,event_type,title,body,data,category,available_at)
SELECT 'batch:'||n,f.member_ids[1],CASE WHEN n<=80 THEN 'lineup_inactive' ELSE 'lineup_empty' END,
  'Batch fixture','Fixture',jsonb_build_object(
    'leagueId',CASE WHEN n>190 THEN upper(f.league_id::text) WHEN n>180 THEN 'invalid' ELSE f.league_id::text END,
    'memberId',f.member_ids[1], 'playerId',f.player_id,
    'gameDate',CASE WHEN n>160 AND n<=180 THEN '2026-10-28' ELSE '2026-10-29' END),
  'lineup','1900-01-01'
FROM notification_batch_fixture f CROSS JOIN generate_series(1,200) n;
CREATE TEMP TABLE notification_batch_result AS SELECT * FROM claim_notification_outbox_atomic(200,60);
DO $$
BEGIN
  PERFORM pg_temp.check_rules((SELECT calls<=2 FROM notification_batch_counter),'lineup candidates run once per distinct scope');
  PERFORM pg_temp.check_rules((SELECT count(*)=160 FROM notification_batch_result),'all current messages are claimed');
  PERFORM pg_temp.check_rules((SELECT count(*)=40 FROM notification_outbox WHERE suppression_reason='stale'),'stale dates and malformed or noncanonical identifiers are suppressed');
  PERFORM pg_temp.check_rules((SELECT count(*)=160 FROM notification_outbox WHERE claim_token IS NOT NULL),'claims retain their leases');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
