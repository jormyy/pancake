BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; rookie uuid; draft uuid; pick uuid; offer uuid; before_state jsonb; kind public.draft_type;
BEGIN
  FOREACH kind IN ARRAY ARRAY['snake','auction']::public.draft_type[] LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2,9532,'drafting');
    rookie:=gen_random_uuid(); draft:=gen_random_uuid(); pick:=gen_random_uuid(); offer:=gen_random_uuid();
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
      VALUES(rookie,'Moved',kind::text,'PG',ARRAY['PG'],0,1);
    INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
      VALUES(draft,f.league_id,f.season_id,kind,'in_progress',false,1);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,f.member_ids[1],rookie,'draft');
    IF kind='snake' THEN
      INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)
        VALUES(pick,f.league_id,9532,1,f.member_ids[1],f.member_ids[1],true,now(),draft);
      INSERT INTO snake_draft_picks(draft_id,member_id,round,pick_in_round,overall_pick,player_id,picked_at,draft_pick_id)
        VALUES(draft,f.member_ids[1],1,1,1,rookie,now(),pick);
    ELSE
      INSERT INTO nominations(draft_id,player_id,nominating_member_id,status,winning_member_id,nomination_order)
        VALUES(draft,rookie,f.member_ids[1],'sold',f.member_ids[1],1);
    END IF;
    IF kind='auction' THEN UPDATE leagues SET status='active' WHERE id=f.league_id; END IF;
    INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at,veto_window_expires_at)
      VALUES(offer,f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'accepted',now(),now()-interval '1 hour');
    INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
      VALUES(offer,f.member_ids[1],0,true,now()),(offer,f.member_ids[2],1,false,now());
    INSERT INTO trade_items(trade_id,side,player_id,from_member_id,to_member_id)
      VALUES(offer,'proposer',rookie,f.member_ids[1],f.member_ids[2]);
    PERFORM public.complete_accepted_trade_atomic(offer);
    PERFORM pg_temp.check_rules((SELECT status='completed' FROM trades WHERE id=offer),kind||' traded player settles');
    SELECT jsonb_build_object('rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM roster_players r WHERE league_id=f.league_id),
      'picks',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM draft_picks p WHERE league_id=f.league_id)) INTO before_state;
    PERFORM pg_temp.reject_rules(format('SELECT public.reset_draft_atomic(%L,%L)',draft,f.user_ids[1]),
      'A player from this draft was traded, so this draft can no longer be reset.',kind||' reset refuses a moved player');
    PERFORM pg_temp.check_rules(before_state=jsonb_build_object('rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM roster_players r WHERE league_id=f.league_id),
      'picks',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM draft_picks p WHERE league_id=f.league_id)),kind||' refused reset preserves rosters and picks');
    offer:=gen_random_uuid();
    INSERT INTO trades(id,league_id,league_season_id,proposer_member_id,recipient_member_id,status,accepted_at,veto_window_expires_at)
      VALUES(offer,f.league_id,f.season_id,f.member_ids[2],f.member_ids[1],'accepted',now(),now()-interval '1 hour');
    INSERT INTO trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)
      VALUES(offer,f.member_ids[2],0,true,now()),(offer,f.member_ids[1],1,false,now());
    INSERT INTO trade_items(trade_id,side,player_id,from_member_id,to_member_id)
      VALUES(offer,'proposer',rookie,f.member_ids[2],f.member_ids[1]);
    PERFORM public.complete_accepted_trade_atomic(offer);
    PERFORM pg_temp.check_rules((SELECT member_id=f.member_ids[1] AND acquired_via='trade' FROM roster_players WHERE player_id=rookie AND league_season_id=f.season_id),kind||' trade-back retains trade provenance');
    PERFORM pg_temp.reject_rules(format('SELECT public.reset_draft_atomic(%L,%L)',draft,f.user_ids[1]),
      'A player from this draft was traded, so this draft can no longer be reset.',kind||' reset also refuses a traded-back player');
  END LOOP;
END;
$$;
DO $$
DECLARE f record; rookie uuid:=gen_random_uuid(); draft uuid:=gen_random_uuid(); pick uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9536,'drafting');
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(rookie,'Untouched','Rookie','PG',ARRAY['PG'],0,1);
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
    VALUES(draft,f.league_id,f.season_id,'snake','in_progress',false,1);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],rookie,'draft');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)
    VALUES(pick,f.league_id,9536,1,f.member_ids[1],f.member_ids[1],true,now(),draft);
  INSERT INTO snake_draft_picks(draft_id,member_id,round,pick_in_round,overall_pick,player_id,picked_at,draft_pick_id)
    VALUES(draft,f.member_ids[1],1,1,1,rookie,now(),pick);
  PERFORM public.reset_draft_atomic(p_draft_id=>draft,p_actor_user_id=>f.user_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=f.season_id),
    'untouched draft removes drafted players');
  PERFORM pg_temp.check_rules((SELECT NOT is_used AND used_at IS NULL AND rookie_draft_id IS NULL FROM draft_picks WHERE id=pick),
    'untouched draft refunds the rookie pick');
END;
$$;
DO $$
DECLARE f record; rookie uuid:=gen_random_uuid(); draft uuid:=gen_random_uuid(); pick uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9536,'drafting');
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
    VALUES(rookie,'Dropped','Rookie','PG',ARRAY['PG'],0,1);
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
    VALUES(draft,f.league_id,f.season_id,'snake','in_progress',false,1);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],rookie,'draft');
  INSERT INTO draft_picks(id,league_id,season_year,round,original_owner_id,current_owner_id,is_used,used_at,rookie_draft_id)
    VALUES(pick,f.league_id,9536,1,f.member_ids[1],f.member_ids[1],true,now(),draft);
  INSERT INTO snake_draft_picks(draft_id,member_id,round,pick_in_round,overall_pick,player_id,picked_at,draft_pick_id)
    VALUES(draft,f.member_ids[1],1,1,1,rookie,now(),pick);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM public.drop_player_atomic((SELECT id FROM roster_players WHERE league_season_id=f.season_id AND player_id=rookie),f.season_id,NULL);
  PERFORM public.reset_draft_atomic(p_draft_id=>draft,p_actor_user_id=>f.user_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=f.season_id),
    'dropped drafted player removes drafted players');
  PERFORM pg_temp.check_rules((SELECT NOT is_used AND used_at IS NULL AND rookie_draft_id IS NULL FROM draft_picks WHERE id=pick),
    'dropped drafted player refunds the rookie pick');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
