BEGIN;
\ir rules-support.sql
DO $$
DECLARE fixture record; player_id uuid:=gen_random_uuid(); profile jsonb;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,2026,'active');
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_reason)
    VALUES(player_id,'Release','Values','PG',ARRAY['PG'],'Ankle');
  INSERT INTO public.dynasty_rankings(source,source_rank,source_player_name,player_id,trade_value,fetched_at)
    VALUES('onenumberhoops.com',99999,'Release Values',player_id,999.9,now());
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  profile:=public.view_player(fixture.league_id,fixture.member_ids[1],jsonb_build_object('playerId',player_id,'section','overview'));
  PERFORM pg_temp.check_rules(profile ? 'pickup' AND NOT profile ? 'lines','compact profile preserves separate sections');
  PERFORM pg_temp.check_rules((profile->'player'->>'trade_value')::numeric=999.9,'compact profile includes the stored trade value');
  PERFORM pg_temp.check_rules(profile->'player'->>'injury_reason'='Ankle','compact profile preserves injury details');
  profile:=public.view_player(fixture.league_id,fixture.member_ids[1],jsonb_build_object('playerId',player_id));
  PERFORM pg_temp.check_rules((profile->'player'->>'trade_value')::numeric=999.9 AND profile ? 'lines','legacy profile keeps values and game lines');
  EXECUTE 'RESET ROLE';
  DELETE FROM private.work_items;
  PERFORM private.enqueue_scheduled_work('2026-06-20 11:00 UTC');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-trade-values'),'trade values wait until seven-fifteen Eastern');
  PERFORM private.enqueue_scheduled_work('2026-06-20 11:15 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='sync-trade-values'),'trade values retain their daily schedule');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='process-waivers'
    AND payload->>'timezone'='America/Los_Angeles' AND payload->>'date'='2026-06-20'
    AND due_at='2026-06-20 07:00 UTC'::timestamptz),'waivers retain league-local midnight beside trade values');
  UPDATE private.work_items SET status='succeeded',lease_token=NULL,lease_until=NULL;
  PERFORM private.enqueue_scheduled_work('2026-06-20 11:30 UTC');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='sync-trade-values'),'trade values enqueue once per Eastern day');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
