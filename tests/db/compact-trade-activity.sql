BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE compact_feed_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9582);
CREATE TEMP TABLE compact_feed_events(label text, id uuid);
GRANT SELECT ON compact_feed_fixture,compact_feed_events TO authenticated;
DO $$
DECLARE f record; player_ids uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid()]; completed uuid; pending uuid; event_id uuid; tx_type text;
BEGIN
  SELECT * INTO f FROM compact_feed_fixture;
  UPDATE leagues SET trade_veto_mode='commissioner',trade_veto_window_hours=24 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,nba_id,nba_team,years_exp,career_regular_season_games)
    SELECT player_ids[n],'Compact','Player '||n,'PG',ARRAY['PG'],'compact-'||player_ids[n]::text,'BOS',2,100 FROM generate_series(1,2) n;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[n],player_ids[n],'draft' FROM generate_series(1,2) n;
  completed:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[player_ids[1]],ARRAY[player_ids[2]],'{}','{}',NULL,NULL,1,2);
  PERFORM public.accept_trade_atomic(completed,f.member_ids[2]);
  UPDATE trades SET veto_window_expires_at=now()-interval '1 minute' WHERE id=completed;
  PERFORM public.complete_accepted_trade_atomic(completed);
  INSERT INTO compact_feed_events SELECT 'hidden',id FROM roster_transactions WHERE related_trade_id=completed AND transaction_type IN ('trade_in','trade_out');
  INSERT INTO compact_feed_events SELECT 'card',id FROM league_activity WHERE related_trade_id=completed AND event_type='trade_completed';
  UPDATE roster_transactions SET occurred_at=now()+interval '2 hours' WHERE related_trade_id=completed;
  UPDATE league_activity SET created_at=now()+interval '1 hour' WHERE related_trade_id=completed AND event_type='trade_completed';
  FOREACH tx_type IN ARRAY ARRAY['fa_add','fa_drop','waiver_add','waiver_drop','draft_won','carry_over','trade_in','trade_out'] LOOP
    event_id:=gen_random_uuid();
    INSERT INTO roster_transactions(id,league_id,league_season_id,member_id,player_id,transaction_type)
      VALUES(event_id,f.league_id,f.season_id,f.member_ids[1],player_ids[1],tx_type);
    INSERT INTO compact_feed_events VALUES('kept',event_id);
  END LOOP;
  event_id:=gen_random_uuid();
  INSERT INTO roster_transactions(id,league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
    VALUES(event_id,f.league_id,f.season_id,f.member_ids[1],player_ids[1],'fa_drop',completed);
  INSERT INTO compact_feed_events VALUES('kept',event_id);
  pending:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],'{}','{}','{}','{}',NULL,NULL,1,1);
  event_id:=gen_random_uuid();
  INSERT INTO roster_transactions(id,league_id,league_season_id,member_id,player_id,transaction_type,related_trade_id)
    VALUES(event_id,f.league_id,f.season_id,f.member_ids[1],player_ids[1],'trade_in',pending);
  INSERT INTO compact_feed_events VALUES('kept',event_id);
  event_id:=gen_random_uuid();
  INSERT INTO league_activity(id,league_id,league_season_id,actor_member_id,event_type,title)
    VALUES(event_id,f.league_id,f.season_id,f.member_ids[1],'commissioner_announcement','Standalone announcement');
  INSERT INTO compact_feed_events VALUES('kept',event_id);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; page jsonb; card jsonb;
BEGIN
  SELECT * INTO f FROM compact_feed_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
  SELECT public.view_activity(f.league_id,f.member_ids[3],'{"limit":100}') INTO page;
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM jsonb_array_elements(page->'rows') item WHERE item->>'transactionType'='trade_completed'),
    'one completed trade occupies one card');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(page->'rows') item JOIN compact_feed_events event ON event.id=(item->>'id')::uuid WHERE event.label='hidden'),
    'completed trade player transactions do not occupy feed rows');
  PERFORM pg_temp.check_rules((SELECT count(*)=count(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(page->'rows') item WHERE (item->>'id')::uuid=event.id)) FROM compact_feed_events event WHERE event.label='kept'),
    'standalone transactions, unrelated activity, incomplete trade rows, and planned drops stay visible');
  SELECT item INTO card FROM jsonb_array_elements(page->'rows') item WHERE item->>'transactionType'='trade_completed';
  PERFORM pg_temp.check_rules(jsonb_array_length(card->'tradePlayers')=2 AND jsonb_array_length(card->'participantTeamNames')=2,
    'the trade card includes both player identities and team names');
  PERFORM pg_temp.check_rules(jsonb_array_length(card->'tradeFaab')=2, 'trade cards retain routed FAAB amounts');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(card->'tradePlayers') player WHERE player->>'nbaId' IS NULL
      OR player->>'position'<>'PG' OR player->>'nbaTeam'<>'BOS' OR player->'eligiblePositions'<>'["PG"]'::jsonb
      OR (player->>'yearsExp')::int<>2 OR (player->>'careerGames')::int<>100),
    'trade players include headshot and stats header fields');
  PERFORM pg_temp.check_rules((SELECT id=(SELECT id FROM compact_feed_events WHERE label='card') FROM public.get_league_activity_feed(f.league_id,1,0)),
    'hidden player rows do not consume the first page');
  PERFORM pg_temp.check_rules((SELECT count(*)=4 FROM roster_transactions tx JOIN compact_feed_events event ON event.id=tx.id WHERE event.label='hidden'),
    'grouping preserves every stored trade transaction');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
