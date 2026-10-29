BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  offered uuid; dropped uuid; other uuid; pick uuid; trade_id uuid; claim_id uuid; snapshot jsonb; before_version bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9391);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9391,1,current_date-1,current_date+5);
  UPDATE public.leagues SET allow_inactive_trades=true, ir_slots=3, taxi_slots=3 WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,years_exp)
    SELECT id,'Lock',ordinal::text,'PG',ARRAY['PG'],'Out',0 FROM unnest(players) WITH ORDINALITY AS ids(id,ordinal);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],'draft') RETURNING id INTO offered;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[2],'draft') RETURNING id INTO dropped;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],players[3],'draft') RETURNING id INTO other;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',2),(f.league_id,'BE',5)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],1,current_date,'PG');
  INSERT INTO public.draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
    VALUES(f.league_id,9392,1,f.member_ids[1],f.member_ids[1]) RETURNING id INTO pick;
  SET CONSTRAINTS private.league_version_commit IMMEDIATE;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  trade_id := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[1]],ARRAY[players[3]],ARRAY[pick],'{}');
  PERFORM pg_temp.check_rules((SELECT version>before_version FROM public.league_versions WHERE league_id=f.league_id),'lock creation increments league version');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)',offered),'Locked by trade '||left(trade_id::text,8)||'.%', 'pending outgoing drop rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.toggle_ir_atomic(%L,true,%L)',offered,f.user_ids[1]),'Locked by trade %', 'pending outgoing IR move rejected');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_taxi=true WHERE id=%L',offered),'Locked by trade %', 'pending outgoing taxi move rejected');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET member_id=%L WHERE id=%L',f.member_ids[2],offered),'Locked by trade %', 'direct ownership change rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.set_player_slot_atomic(%L,%L,%L,%L,current_date,''BE'',1)',f.member_ids[1],f.league_id,f.season_id,players[1]),'Locked by trade %','single lineup slot writer rejects lock');
  PERFORM pg_temp.reject_rules(format('SELECT public.set_player_slot_moves_atomic(%L,%L,%L,current_date,1,%L::jsonb)',f.member_ids[1],f.league_id,f.season_id,jsonb_build_array(jsonb_build_object('player_id',players[1],'slot_type','BE'))),'Locked by trade %','batch lineup writer rejects lock');
  PERFORM pg_temp.reject_rules(format('DELETE FROM public.weekly_lineups WHERE player_id=%L',players[1]),'Locked by trade %', 'direct lineup delete rejected');
  PERFORM pg_temp.reject_rules(format('UPDATE public.weekly_lineups SET slot_type=''BE'' WHERE player_id=%L',players[1]),'Locked by trade %', 'direct lineup move rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,current_date,''[]''::jsonb)',f.member_ids[1],f.league_id,f.season_id),'Locked by trade %', 'lineup replacement rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_service_atomic(%L,%L,%L,current_date,''[]''::jsonb)',f.member_ids[1],f.league_id,f.season_id),'Locked by trade %','service lineup optimizer rejects moving locks');
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,current_date,jsonb_build_array(jsonb_build_object('player_id',players[1],'slot_type','PG')));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE player_id=players[1]), 'unchanged locked lineup allowed');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L::uuid[],%L::uuid[],''{}'',''{}'')',f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[1]],ARRAY[players[3]]),'Locked by trade %', 'second outgoing trade rejected');
  PERFORM pg_temp.reject_rules(format('DELETE FROM public.draft_picks WHERE id=%L',pick),'Locked by trade %','pending pick deletion rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,''{}''::uuid[],%L::uuid[],%L::uuid[],''{}''::uuid[])',f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[3]],ARRAY[pick]),'Locked by trade %','same pick cannot enter another trade');
  PERFORM pg_temp.reject_rules(format('UPDATE public.draft_picks SET current_owner_id=%L WHERE id=%L',f.member_ids[2],pick),'Locked by trade %','pending pick transfer rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.create_waiver_claim_atomic(%L,%L,%L,%L)',f.league_id,f.member_ids[1],players[4],players[1]),'Locked by trade %','trade asset waiver drop rejected');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])), 'outgoing player and pick lock');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[2])), 'unsent recipient assets stay usable');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_roster(f.league_id,f.member_ids[1],jsonb_build_object('targetMemberId',f.member_ids[2]))->'lockedAssets')=0,'another roster does not expose private locks');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_roster(%L,%L)',f.league_id,f.member_ids[1]),'This screen is not available.','snapshot reader rejects another manager identity');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  snapshot := public.view_roster(f.league_id,f.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(snapshot->'lockedAssets')=2,'roster snapshot includes locks');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_lineup(f.league_id,f.member_ids[1])->'lockedAssets')=2,'lineup snapshot includes locks');
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM public.withdraw_trade_atomic(trade_id,f.member_ids[1],f.user_ids[1]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])),'withdraw releases locks');
  PERFORM pg_temp.check_rules((SELECT version>before_version FROM public.league_versions WHERE league_id=f.league_id),'cancellation increments league version');
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,current_date,'[]');
  PERFORM public.toggle_ir_atomic(offered,true,f.user_ids[1]);
  PERFORM public.toggle_ir_atomic(offered,false,f.user_ids[1]);
  PERFORM pg_temp.check_rules(true,'lineup IR and taxi allowed after withdraw');
  UPDATE public.draft_picks SET current_owner_id=f.member_ids[2] WHERE id=pick;
  PERFORM pg_temp.check_rules(true,'pick transfer allowed after withdraw');
  claim_id := public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],players[4],players[2]);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])),'claim and drop candidate lock');
  snapshot:=public.view_claim_editor(f.league_id,f.member_ids[1],jsonb_build_object('playerId',players[4]));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'roster') row_data WHERE row_data->'players'->>'id'=players[2]::text AND jsonb_array_length(row_data->'assetLocks')=1),'new claim picker receives the existing drop reservation');
  snapshot:=public.view_claim_editor(f.league_id,f.member_ids[1],jsonb_build_object('playerId',players[4],'claimId',claim_id));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'roster') row_data WHERE row_data->'players'->>'id'=players[2]::text AND jsonb_array_length(row_data->'assetLocks')=0),'claim edit keeps its own drop without hiding other reservations');
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)',dropped),'Locked by waiver claim '||left(claim_id::text,8)||'.%','waiver drop rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.toggle_ir_atomic(%L,true,%L)',dropped,f.user_ids[1]),'Locked by waiver claim %','waiver IR move rejected');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_taxi=true WHERE id=%L',dropped),'Locked by waiver claim %','waiver taxi move rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,current_date,%L::jsonb)',f.member_ids[1],f.league_id,f.season_id,jsonb_build_array(jsonb_build_object('player_id',players[2],'slot_type','PG'))),'Locked by waiver claim %','waiver lineup addition rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.propose_trade_atomic(%L,%L,%L,%L,%L::uuid[],%L::uuid[],''{}'',''{}'')',f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[2]],ARRAY[players[3]]),'Locked by waiver claim %','waiver asset trade rejected');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[4],'waiver');
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(id) FROM public.roster_players WHERE league_id=%L AND player_id=%L',f.league_id,players[4]),'Locked by waiver claim %','pending claim protects its acquired player');
  PERFORM public.cancel_waiver_claim_atomic(claim_id,f.member_ids[1],f.user_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])),'cancel claim releases locks');
  PERFORM public.toggle_ir_atomic(dropped,true,f.user_ids[1]);
  PERFORM public.toggle_ir_atomic(dropped,false,f.user_ids[1]);
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,current_date,jsonb_build_array(jsonb_build_object('player_id',players[2],'slot_type','PG')));
  PERFORM public.drop_player_atomic(dropped);
  PERFORM public.drop_player_atomic(offered);
  PERFORM public.drop_player_atomic((SELECT id FROM public.roster_players WHERE league_id=f.league_id AND player_id=players[4]));
  PERFORM pg_temp.check_rules(true,'claim cancellation restores roster and lineup writes');
END;
$$;
DO $$
DECLARE f record; players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  ir_roster uuid; taxi_roster uuid; active_roster uuid; trade_id uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9392);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9392,1,current_date-1,current_date+5);
  UPDATE public.leagues SET roster_size=2,ir_slots=1,taxi_slots=1,allow_inactive_trades=true WHERE id=f.league_id;
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',2),(f.league_id,'BE',2)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,injury_status,years_exp)
    SELECT id,'Inactive lock',ordinal::text,'PG',ARRAY['PG'],'Out',0 FROM unnest(players) WITH ORDINALITY ids(id,ordinal);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,is_on_ir,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],true,'draft') RETURNING id INTO ir_roster;
  PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],players[2],'draft',gen_random_uuid());
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[2],true,'draft') RETURNING id INTO taxi_roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[3],'draft') RETURNING id INTO active_roster;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],players[4],'draft');
  PERFORM set_config('request.jwt.claim.sub','',true);
  trade_id:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],players[1:2],ARRAY[players[4]],'{}','{}');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L,%L)',ir_roster,f.season_id),'Locked by trade %','two-argument drop rejects locked asset');
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L,%L,NULL)',ir_roster,f.season_id),'Locked by trade %','three-argument drop rejects locked asset');
  PERFORM pg_temp.reject_rules(format('SELECT public.toggle_taxi_atomic(%L,false,%L)',taxi_roster,f.user_ids[1]),'Locked by trade %','taxi activation rejects locked asset');
  PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_overflow_atomic(%L,''ir'',%L,''drop'')',ir_roster,active_roster),'Locked by trade %','overflow activation rejects locked target');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.roster_players WHERE id=active_roster),'failed overflow activation restores its drop');
  PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_overflow_atomic(%L,''ir'',%L,''ir'')',ir_roster,active_roster),'Locked by trade %','IR swap rejects locked target');
  PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM public.roster_players WHERE id=active_roster),'failed IR swap restores placement');
  PERFORM pg_temp.reject_rules(format('SELECT public.activate_roster_player_with_lineup_atomic(%L,''taxi'',NULL,NULL,%L,%L,%L,current_date,1,''PG'')',taxi_roster,f.member_ids[1],f.league_id,f.season_id),'Locked by trade %','lineup activation rejects locked taxi player');
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM public.withdraw_trade_atomic(trade_id,f.member_ids[1],f.user_ids[1]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.activate_roster_player_with_lineup_atomic(taxi_roster,'taxi',NULL,NULL,f.member_ids[1],f.league_id,f.season_id,current_date,1,'PG');
  PERFORM pg_temp.check_rules((SELECT NOT is_on_taxi FROM public.roster_players WHERE id=taxi_roster),'cancel releases compound taxi activation');
  PERFORM public.activate_roster_player_with_overflow_atomic(ir_roster,'ir',active_roster,'drop');
  PERFORM pg_temp.check_rules((SELECT NOT is_on_ir FROM public.roster_players WHERE id=ir_roster) AND NOT EXISTS(SELECT 1 FROM public.roster_players WHERE id=active_roster),'cancel releases overflow activation');
END;
$$;
DO $$
DECLARE f record; players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()]; first_claim uuid; second_claim uuid;
BEGIN
  UPDATE public.waiver_claims SET process_date=current_date+365000 WHERE status='pending';
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9393);
  UPDATE public.leagues SET roster_size=1 WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions)
    SELECT id,'Claim lock',ordinal::text,'PG',ARRAY['PG'] FROM unnest(players) WITH ORDINALITY ids(id,ordinal);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],'draft');
  first_claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],players[2],players[1]);
  second_claim:=public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],players[3],players[1]);
  UPDATE public.waiver_claims SET process_date=current_date-2 WHERE id=first_claim;
  UPDATE public.waiver_claims SET process_date=current_date-1 WHERE id=second_claim;
  PERFORM public.process_next_waiver_claim_atomic(current_date);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM public.waiver_claims WHERE id=first_claim),'claim settlement can apply its reserved drop');
  PERFORM pg_temp.check_rules((SELECT status='cancelled' AND failure_reason LIKE '%another successful waiver claim%' FROM public.waiver_claims WHERE id=second_claim),'shared drop cancellation releases the sibling reservation');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])),'successful settlement releases pending claim locks');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
