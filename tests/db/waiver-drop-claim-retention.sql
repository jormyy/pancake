BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  owned uuid := gen_random_uuid();
  target uuid := gen_random_uuid();
  roster uuid;
  claim uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9381);
  UPDATE public.leagues SET allow_inactive_trades=true WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions)
  SELECT id,'Retention',id::text,'PG',ARRAY['PG'] FROM unnest(ARRAY[owned,target]) id;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(f.league_id,f.season_id,f.member_ids[1],owned,'draft') RETURNING id INTO roster;
  INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,clears_at)
  VALUES(f.league_id,f.season_id,target,now()+interval '1 day');
  claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],target,owned,f.user_ids[1]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.drop_player_atomic(roster);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.waiver_claims WHERE id=claim AND status='pending'
    AND drop_player_id IS NULL AND processed_at IS NULL AND failure_reason IS NULL),
    'an ordinary drop keeps the pending claim and clears its drop choice');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.notification_outbox
    WHERE dedupe_key='trade_claim_cancelled:'||claim),'an ordinary drop sends no trade cancellation');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
