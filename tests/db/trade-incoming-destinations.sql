BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  p uuid[];
  t uuid;
  replacement uuid;
  pick uuid;
  destination text;
  payload jsonb;
  before_roster jsonb;
  teams jsonb;
  starting_balance int;
BEGIN
  FOREACH destination IN ARRAY ARRAY['ir','taxi','cancel'] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2,9601+array_position(ARRAY['ir','taxi','cancel'],destination));
    p:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    pick:=gen_random_uuid();
    UPDATE leagues SET roster_size=2,ir_slots=2,taxi_slots=2,allow_inactive_trades=true,
      trade_veto_mode='commissioner',trade_veto_window_hours=24,waiver_mode='faab' WHERE id=f.league_id;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games,injury_status)
      SELECT id,'Incoming proof',destination||' '||n,'PG',ARRAY['PG'],0,0,'Out' FROM unnest(p) WITH ORDINALITY ids(id,n);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir)
      SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n IN(2,6) THEN 2 ELSE 1 END],id,'draft',n=2
      FROM unnest(p[1:6]) WITH ORDINALITY ids(id,n);
    INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id)
      VALUES(pick,f.league_id,9605,1,f.member_ids[1],f.member_ids[1]);
    starting_balance:=private.available_faab_balance(f.league_id,f.season_id,f.member_ids[1]);
    payload:=jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
      'offerPlayerIds',ARRAY[p[1]],'requestPlayerIds',ARRAY[p[2]],'offerPickIds',ARRAY[pick],'offerFaabAmount',5,
      'rosterPlan',jsonb_build_object('irPlayerIds',CASE WHEN destination='taxi' THEN '{}'::uuid[] ELSE ARRAY[p[2]] END,
        'taxiPlayerIds',CASE WHEN destination='taxi' THEN ARRAY[p[2]] ELSE '{}'::uuid[] END,'dropPlayerIds',ARRAY[p[5]],
        'rosterMoves',jsonb_build_array(jsonb_build_object('playerId',p[3],'destination','ir'),jsonb_build_object('playerId',p[4],'destination','taxi'))));
    t:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,f.member_ids[2],p[7],'draft');
    SELECT jsonb_agg(to_jsonb(r) ORDER BY player_id) INTO before_roster FROM roster_players r WHERE league_season_id=f.season_id;
    teams:=public.get_trade_roster_preview(t,f.user_ids[2]);
    PERFORM pg_temp.check_rules(teams->1->'reasons' @> '[{"rule":"active_slots"}]',destination||': incoming Regular placement needs a repair');
    UPDATE players SET injury_status=NULL,years_exp=4,career_regular_season_games=200 WHERE id=p[1];
    PERFORM pg_temp.reject_rules(format('SELECT accept_trade_with_plan_atomic(%L,%L,%L,%L,%L,%L)',t,f.member_ids[2],f.user_ids[2],'{}',ARRAY[p[1]],'{}'),
      '%IR requires an Out or IR designation%',destination||': healthy incoming player cannot use IR');
    PERFORM pg_temp.reject_rules(format('SELECT accept_trade_with_plan_atomic(%L,%L,%L,%L,%L,%L)',t,f.member_ids[2],f.user_ids[2],ARRAY[p[1]],'{}','{}'),
      '%Taxi requires a rookie or fewer than 65 known career games%',destination||': veteran incoming player cannot use taxi');
    PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=t),destination||': rejected choices do not accept the trade');
    UPDATE players SET injury_status='Out',years_exp=0,career_regular_season_games=0 WHERE id=p[1];
    PERFORM public.accept_trade_with_plan_atomic(t,f.member_ids[2],f.user_ids[2],
      CASE WHEN destination='taxi' THEN ARRAY[p[1]] ELSE '{}'::uuid[] END,
      CASE WHEN destination<>'taxi' THEN ARRAY[p[1]] ELSE '{}'::uuid[] END,'{}');
    PERFORM pg_temp.check_rules((SELECT status='accepted' AND veto_window_expires_at>now()+interval '23 hours' FROM trades WHERE id=t),destination||': acceptance starts the review window');
    PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(r) ORDER BY player_id)=before_roster FROM roster_players r WHERE league_season_id=f.season_id),destination||': both rosters wait unchanged');
    PERFORM pg_temp.reject_rules(format('SELECT complete_accepted_trade_atomic(%L)',t),'%window is still open%',destination||': early execution is blocked');
    PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id,f.season_id,f.member_ids[1])=starting_balance-5,destination||': accepted trade reserves its FAAB');
    PERFORM pg_temp.check_rules(private.is_reserved_trade_asset(f.league_id,f.season_id,f.member_ids[1],NULL,pick),destination||': accepted pick is reserved');
    IF destination='cancel' THEN
      PERFORM pg_temp.reject_rules(format('SELECT withdraw_trade_atomic(%L,%L,%L)',t,f.member_ids[2],f.user_ids[2]),'%Only the trade proposer%', 'cancel: another member cannot cancel');
      PERFORM pg_temp.reject_rules(format('SELECT withdraw_trade_atomic(%L,%L,%L)',t,f.member_ids[1],f.user_ids[2]),'%Not authorized%', 'cancel: wrong user cannot act for proposer');
      PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
      PERFORM public.withdraw_trade_atomic(t,f.member_ids[1],f.user_ids[1]);
      PERFORM pg_temp.check_rules(NOT COALESCE(private.trade_lifecycle_write_active(),false),'cancel: authenticated cancellation restores lifecycle context');
      PERFORM set_config('request.jwt.claim.sub','',true);
      PERFORM pg_temp.check_rules((SELECT status='withdrawn' FROM trades WHERE id=t),'cancel: review-window cancellation persists');
      PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(r) ORDER BY player_id)=before_roster FROM roster_players r WHERE league_season_id=f.season_id),'cancel: neither saved plan executes');
      PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM unnest(p) id WHERE private.is_reserved_trade_asset(f.league_id,f.season_id,
        CASE WHEN id=ANY(ARRAY[p[2],p[6],p[7]]) THEN f.member_ids[2] ELSE f.member_ids[1] END,id)), 'cancel: assets and planned moves are released');
      PERFORM pg_temp.check_rules(NOT private.is_reserved_trade_asset(f.league_id,f.season_id,f.member_ids[1],NULL,pick),'cancel: pick is released');
      PERFORM pg_temp.check_rules(private.available_faab_balance(f.league_id,f.season_id,f.member_ids[1])=starting_balance,'cancel: FAAB is released');
      PERFORM pg_temp.reject_rules(format('SELECT complete_accepted_trade_atomic(%L)',t),'%not ready to complete%','cancel: cancelled trade cannot execute');
      payload:=payload||jsonb_build_object('rosterPlans',jsonb_build_object(f.member_ids[2]::text,jsonb_build_object('irPlayerIds',ARRAY[p[1]])));
      replacement:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',payload);
      PERFORM pg_temp.check_rules(replacement IS NOT NULL,'cancel: the same assets and both saved plans can be offered again');
      PERFORM public.accept_trade_with_plan_atomic(replacement,f.member_ids[2],f.user_ids[2],'{}',ARRAY[p[1]],'{}');
      UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=replacement;
      PERFORM pg_temp.reject_rules(format('SELECT withdraw_trade_atomic(%L,%L,%L)',replacement,f.member_ids[1],f.user_ids[1]),'%review window%', 'cancel: cancellation closes when review ends');
      UPDATE trades SET veto_window_expires_at=NULL WHERE id=replacement;
      PERFORM pg_temp.reject_rules(format('SELECT withdraw_trade_atomic(%L,%L,%L)',replacement,f.member_ids[1],f.user_ids[1]),'%review window%', 'cancel: a missing review deadline does not allow cancellation');
    ELSE
      UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=t;
      PERFORM public.complete_accepted_trade_atomic(t);
      PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=t),destination||': execution completes');
      PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[2] AND is_on_ir=(destination='ir') AND is_on_taxi=(destination='taxi') FROM roster_players WHERE player_id=p[1]),destination||': incoming player reaches the chosen slot');
      PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] AND is_on_ir=(destination='ir') AND is_on_taxi=(destination='taxi') FROM roster_players WHERE player_id=p[2]),destination||': sender incoming player reaches the saved slot');
      PERFORM pg_temp.check_rules((SELECT is_on_ir FROM roster_players WHERE player_id=p[3]),destination||': sender retained IR move executes');
      PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM roster_players WHERE player_id=p[4]),destination||': sender retained taxi move executes');
      PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE player_id=p[5]),destination||': sender drop executes');
      PERFORM pg_temp.check_rules((SELECT current_owner_id=f.member_ids[2] FROM draft_picks WHERE id=pick),destination||': pick transfers with the roster plans');
      teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,'[]','{}');
      PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(teams) team WHERE NOT (team->>'legal')::boolean),destination||': both final rosters are legal');
    END IF;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
