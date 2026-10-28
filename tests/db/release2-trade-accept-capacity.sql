BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; incoming uuid; retained uuid; offer uuid; location text; method text; taxi uuid[]; ir uuid[]; preview jsonb; own_preview jsonb;
BEGIN
  FOREACH location IN ARRAY ARRAY['active','ir','taxi'] LOOP
    FOREACH method IN ARRAY ARRAY['plain','plan'] LOOP
      SELECT * INTO f FROM pg_temp.rules_fixture(2,9580);
      UPDATE leagues SET roster_size=1,ir_slots=1,taxi_slots=1,allow_inactive_trades=true,taxi_rule='rookies_or_64_games',taxi_max_seasons=NULL WHERE id=f.league_id;
      incoming:=gen_random_uuid(); retained:=gen_random_uuid();
      INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,injury_status)
        SELECT id,'Capacity',id::text,'PG',ARRAY['PG'],0,'Out' FROM unnest(ARRAY[incoming,retained]) id;
      IF location='taxi' THEN
        PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[1],incoming,'draft',gen_random_uuid());
        PERFORM private.authorize_taxi_acquisition(f.league_id,f.season_id,f.member_ids[2],retained,'draft',gen_random_uuid());
      END IF;
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi)
        VALUES(f.league_id,f.season_id,f.member_ids[1],incoming,'draft',false,location='taxi'),
          (f.league_id,f.season_id,f.member_ids[2],retained,'draft',location='ir',location='taxi');
      offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',
        jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
          'offerPlayerIds',ARRAY[incoming],'requestPlayerIds','[]'::jsonb,'requestFaabAmount',1));
      taxi:=CASE WHEN location='taxi' THEN ARRAY[incoming] ELSE '{}'::uuid[] END;
      ir:=CASE WHEN location='ir' THEN ARRAY[incoming] ELSE '{}'::uuid[] END;
      PERFORM public.set_trade_roster_plan_atomic(offer,f.member_ids[2],f.user_ids[2],taxi,ir,'{}');
      preview:=public.get_trade_roster_preview(offer,f.user_ids[2]);
      SELECT value INTO own_preview FROM jsonb_array_elements(preview) WHERE value->>'memberId'=f.member_ids[2]::text;
      PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM jsonb_array_elements(own_preview->'roster') WHERE value->>'location'=location)
        AND own_preview->>'error' IS NOT NULL,location||' '||method||' preview exposes one required drop');
      IF method='plain' THEN
        PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_atomic(%L,%L)',offer,f.member_ids[2]),
          CASE WHEN location='taxi' THEN '%taxi%' ELSE 'Rules team 2 must change its trade plan to meet the % limit.' END,location||' plain acceptance rejects overflow');
      ELSE
        PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_with_plan_atomic(%L,%L,%L,%L,%L,%L)',offer,f.member_ids[2],f.user_ids[2],taxi,ir,'{}'),
          CASE WHEN location='taxi' THEN '%taxi%' ELSE 'Rules team 2 must change its trade plan to meet the % limit.' END,location||' atomic plan rejects overflow');
      END IF;
      PERFORM pg_temp.check_rules((SELECT status='pending' FROM trades WHERE id=offer)
        AND (SELECT accepted_at IS NULL AND cardinality(drop_player_ids)=0 FROM trade_participants WHERE trade_id=offer AND member_id=f.member_ids[2]),
        location||' '||method||' rejected acceptance preserves state');
      IF method='plain' THEN
        PERFORM public.set_trade_roster_plan_atomic(offer,f.member_ids[2],f.user_ids[2],taxi,ir,ARRAY[retained]);
        PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
      ELSE
        PERFORM public.accept_trade_with_plan_atomic(offer,f.member_ids[2],f.user_ids[2],taxi,ir,ARRAY[retained]);
      END IF;
      PERFORM pg_temp.check_rules((SELECT status='accepted' FROM trades WHERE id=offer)
        AND (SELECT drop_player_ids=ARRAY[retained] FROM trade_participants WHERE trade_id=offer AND member_id=f.member_ids[2]),
        location||' '||method||' legal drop plan permits acceptance');
      PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.trade_resulting_roster(offer,f.member_ids[2])),
        location||' '||method||' resulting roster stays legal');
    END LOOP;
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
