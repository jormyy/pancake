-- Real draft/trade acquisition, irreversible exit, grants, capacity and rollback.
-- Each fixture is synthetic and rolls back. The rollover test simulates only
-- completion of its own waiver hold; waiver processing is verified separately.
BEGIN;
SET LOCAL statement_timeout = '45s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE taxi_acceptance_ids(name text PRIMARY KEY, id uuid NOT NULL UNIQUE);
CREATE TEMP TABLE taxi_acceptance_checks(name text PRIMARY KEY);
CREATE FUNCTION pg_temp.taxi_id(p_name text) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM taxi_acceptance_ids WHERE name=p_name
$$;
CREATE FUNCTION pg_temp.taxi_check(p_condition boolean,p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',p_name; END IF;
  INSERT INTO taxi_acceptance_checks VALUES(p_name);
END;
$$;
CREATE FUNCTION pg_temp.taxi_fails(p_sql text,p_state text,p_message text,p_name text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_message text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
  END;
  PERFORM pg_temp.taxi_check(v_state=p_state AND v_message ~ p_message,
    p_name||COALESCE(' ['||v_state||': '||v_message||']',' [unexpected success]'));
END;
$$;

-- Create independent worlds. Draft assets start with one owner for deterministic pick order.
DO $$
DECLARE v_name text; v_world text; v_id uuid; v_team text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['user-a','user-b','user-outsider'] LOOP
    v_id:=gen_random_uuid();
    INSERT INTO taxi_acceptance_ids VALUES(v_name,v_id);
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,
      raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES(v_id,'authenticated','authenticated','taxi-'||v_id||'@example.test','x',now(),
      '{}'::jsonb,jsonb_build_object('username','taxi_'||replace(v_id::text,'-','')),now(),now());
    INSERT INTO profiles(id,username,display_name)
    VALUES(v_id,'taxi_'||replace(v_id::text,'-',''),'Synthetic taxi acceptance') ON CONFLICT(id) DO NOTHING;
  END LOOP;
  FOREACH v_world IN ARRAY ARRAY['snake','auction','life','late'] LOOP
    INSERT INTO taxi_acceptance_ids VALUES(v_world||'-league',gen_random_uuid()),
      (v_world||'-season',gen_random_uuid()),(v_world||'-a',gen_random_uuid()),(v_world||'-b',gen_random_uuid());
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,taxi_slots,ir_slots,
      auction_budget,trade_veto_mode,trade_veto_window_hours,trade_deadline,weekly_add_limit)
    VALUES(pg_temp.taxi_id(v_world||'-league'),'Synthetic taxi acceptance',
      'taxi-'||pg_temp.taxi_id(v_world||'-league'),pg_temp.taxi_id('user-a'),
      CASE WHEN v_world='auction' THEN 'setup'::league_status ELSE 'offseason'::league_status END,
      CASE WHEN v_world='snake' THEN 1 ELSE 20 END,
      CASE WHEN v_world='life' THEN 4 ELSE 1 END,2,100,
      CASE WHEN v_world='late' THEN 'member_vote' ELSE 'disabled' END,
      CASE WHEN v_world='late' THEN 1 ELSE 0 END,NULL,NULL);
    INSERT INTO league_seasons(id,league_id,season_year,is_current)
    VALUES(pg_temp.taxi_id(v_world||'-season'),pg_temp.taxi_id(v_world||'-league'),
      public.current_season_year_et(now()),true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at)
    VALUES(pg_temp.taxi_id(v_world||'-a'),pg_temp.taxi_id(v_world||'-league'),
      pg_temp.taxi_id('user-a'),'commissioner','Synthetic A',now()-interval '2 days'),
      (pg_temp.taxi_id(v_world||'-b'),pg_temp.taxi_id(v_world||'-league'),
      pg_temp.taxi_id('user-b'),'manager','Synthetic B',now()-interval '1 day');
    IF v_world<>'auction' THEN
      INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
      SELECT pg_temp.taxi_id(v_world||'-league'),public.current_season_year_et(now()),r,m,
        pg_temp.taxi_id(v_world||'-a')
      FROM generate_series(1,2) r CROSS JOIN
        unnest(ARRAY[pg_temp.taxi_id(v_world||'-a'),pg_temp.taxi_id(v_world||'-b')]) m;
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['snake-first','snake-capacity','snake-veteran','snake-started',
    'life-activate','life-ir','life-drop','life-carry','life-trade-in','life-return',
    'life-manual','auction-sale','auction-stale','auction-trade-in','auction-return','late-offer','late-return'] LOOP
    v_id:=gen_random_uuid();
    INSERT INTO taxi_acceptance_ids VALUES(v_name,v_id);
    INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions,years_exp,nba_draft_number,injury_status)
    VALUES(v_id,'Synthetic',v_id::text,NULL,'PG',ARRAY['PG'],
      CASE WHEN v_name='snake-veteran' THEN 1 ELSE 0 END,30,
      CASE WHEN v_name='life-ir' THEN 'Out' ELSE NULL END);
  END LOOP;
  LOOP
    v_team:='Q'||chr(65+(random()*25)::int)||chr(65+(random()*25)::int);
    EXIT WHEN NOT EXISTS(SELECT 1 FROM nba_games WHERE home_team=v_team OR away_team=v_team)
      AND NOT EXISTS(SELECT 1 FROM players WHERE nba_team=v_team);
  END LOOP;
  UPDATE players SET nba_team=v_team WHERE id=pg_temp.taxi_id('snake-started');
  INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,started_at,home_team,away_team,status)
  VALUES(gen_random_uuid(),'002-taxi-'||gen_random_uuid(),public.current_season_year_et(now()),1,
    (now() AT TIME ZONE 'America/New_York')::date,now()-interval '1 minute',now()-interval '1 minute',v_team,'QQQ','InProgress');
  -- These are preexisting active asset fixtures, not taxi entries.
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
  VALUES(pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),pg_temp.taxi_id('life-a'),
      pg_temp.taxi_id('life-trade-in'),'draft'),
    (pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),pg_temp.taxi_id('life-b'),
      pg_temp.taxi_id('life-return'),'draft'),
    (pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),pg_temp.taxi_id('life-a'),
      pg_temp.taxi_id('life-manual'),'draft'),
    (pg_temp.taxi_id('auction-league'),pg_temp.taxi_id('auction-season'),pg_temp.taxi_id('auction-b'),
      pg_temp.taxi_id('auction-trade-in'),'draft'),
    (pg_temp.taxi_id('auction-league'),pg_temp.taxi_id('auction-season'),pg_temp.taxi_id('auction-a'),
      pg_temp.taxi_id('auction-return'),'draft'),
    (pg_temp.taxi_id('late-league'),pg_temp.taxi_id('late-season'),pg_temp.taxi_id('late-a'),
      pg_temp.taxi_id('late-offer'),'draft'),
    (pg_temp.taxi_id('late-league'),pg_temp.taxi_id('late-season'),pg_temp.taxi_id('late-b'),
      pg_temp.taxi_id('late-return'),'draft');
END;
$$;

-- Actual real rookie draft. The first taxi pick consumes its slot and pick asset.
DO $$
DECLARE v_draft uuid; v_slot uuid; v_asset uuid; v_before jsonb; v_result jsonb;
BEGIN
  v_draft:=(public.start_rookie_draft_atomic(pg_temp.taxi_id('snake-league'),2,false,3600,'auto_pick')->>'id')::uuid;
  INSERT INTO taxi_acceptance_ids VALUES('snake-draft',v_draft);
  SELECT id,draft_pick_id INTO v_slot,v_asset FROM snake_draft_picks WHERE draft_id=v_draft ORDER BY overall_pick LIMIT 1;
  v_result:=public.make_snake_pick_atomic(v_draft,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-first'),true);
  PERFORM pg_temp.taxi_check((v_result->>'to_taxi')::boolean,'snake response records taxi destination');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM snake_draft_picks WHERE id=v_slot AND
    player_id=pg_temp.taxi_id('snake-first') AND to_taxi AND picked_at IS NOT NULL),'snake slot records real taxi pick');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM draft_picks WHERE id=v_asset AND is_used AND
    rookie_draft_id=v_draft AND used_at IS NOT NULL),'snake consumes real draft asset');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-first') AND member_id=pg_temp.taxi_id('snake-a')
    AND is_on_taxi AND NOT is_on_ir AND acquired_via='draft'),'snake acquires directly into taxi');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_transactions WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-first') AND transaction_type='draft_won'),'snake keeps acquisition history');

  SELECT id,draft_pick_id INTO v_slot,v_asset FROM snake_draft_picks
    WHERE draft_id=v_draft AND player_id IS NULL ORDER BY overall_pick LIMIT 1;
  SELECT jsonb_build_object('slot',to_jsonb(s),'asset',to_jsonb(p),'draft',to_jsonb(d)) INTO v_before
    FROM snake_draft_picks s JOIN draft_picks p ON p.id=s.draft_pick_id JOIN drafts d ON d.id=s.draft_id WHERE s.id=v_slot;
  PERFORM pg_temp.taxi_fails(format('SELECT public.make_snake_pick_atomic(%L,%L,%L,true)',
    v_draft,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-capacity')),'P0001','taxi squad is full',
    'snake full taxi rejects acquisition');
  PERFORM pg_temp.taxi_check(v_before=(SELECT jsonb_build_object('slot',to_jsonb(s),'asset',to_jsonb(p),'draft',to_jsonb(d))
    FROM snake_draft_picks s JOIN draft_picks p ON p.id=s.draft_pick_id JOIN drafts d ON d.id=s.draft_id WHERE s.id=v_slot),
    'snake capacity failure rolls back complete slot asset and draft');
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-capacity')) AND NOT EXISTS(SELECT 1 FROM roster_transactions
    WHERE league_id=pg_temp.taxi_id('snake-league') AND player_id=pg_temp.taxi_id('snake-capacity')),
    'snake capacity failure creates no roster or history');
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM private.taxi_acquisition_context
    WHERE league_id=pg_temp.taxi_id('snake-league')),'failed snake leaves no private acquisition capability');
  PERFORM pg_temp.taxi_fails(format('SELECT public.make_snake_pick_atomic(%L,%L,%L,true)',
    v_draft,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-veteran')),'P0001','rookie-eligible',
    'snake preserves rookie eligibility');
  PERFORM pg_temp.taxi_fails(format('SELECT public.make_snake_pick_atomic(%L,%L,%L,false)',
    v_draft,pg_temp.taxi_id('snake-b'),pg_temp.taxi_id('snake-capacity')),'P0001','not your pick',
    'snake rejects wrong member on clock');
  PERFORM public.make_snake_pick_atomic(v_draft,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-capacity'),false);
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-capacity') AND NOT is_on_taxi),'snake remains usable after capacity rejection');
  PERFORM pg_temp.taxi_fails(format('SELECT public.toggle_taxi_atomic(%L,false,%L)',
    (SELECT id FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league') AND player_id=pg_temp.taxi_id('snake-first')),
    pg_temp.taxi_id('user-a')),'P0001','active roster is full','taxi activation preserves active capacity rule');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-first') AND is_on_taxi)
    AND NOT EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('snake-league')
      AND player_id=pg_temp.taxi_id('snake-first')),'failed full-roster activation keeps taxi and no exit mark');
  PERFORM pg_temp.taxi_fails(format('SELECT public.toggle_ir_atomic(%L,true,%L)',
    (SELECT id FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league') AND player_id=pg_temp.taxi_id('snake-first')),
    pg_temp.taxi_id('user-a')),'P0001','Only players with Out or IR','taxi to IR preserves injury eligibility');
  PERFORM pg_temp.taxi_fails(format('SELECT public.make_snake_pick_atomic(%L,%L,%L,true)',
    v_draft,pg_temp.taxi_id('snake-a'),pg_temp.taxi_id('snake-started')),'P0001','game has already started',
    'direct draft taxi preserves game-start lock');
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('snake-league')
    AND player_id=pg_temp.taxi_id('snake-started')),'started-game draft taxi failure creates no roster row');
END;
$$;

-- Client callers cannot bypass Edge authorization by passing a member ID to server-only entry functions.
-- The role changes are actual database roles; these do not test HTTP authentication.
DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',pg_temp.taxi_id('user-outsider')::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.make_snake_pick_atomic(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),true);
    RAISE EXCEPTION 'Client directly invokes snake acquisition' USING ERRCODE='P9999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.place_auction_bid_atomic(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),true);
    RAISE EXCEPTION 'Client directly invokes auction acquisition' USING ERRCODE='P9999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.set_trade_taxi_destinations_atomic(gen_random_uuid(),gen_random_uuid(),ARRAY[]::uuid[],gen_random_uuid());
    RAISE EXCEPTION 'Client directly invokes trade destination selection' USING ERRCODE='P9999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM private.authorize_taxi_acquisition(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'draft',gen_random_uuid());
    RAISE EXCEPTION 'Client mints private taxi capability' USING ERRCODE='P9999';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.taxi_check(true,'authenticated role cannot invoke server-only acquisition functions or mint capabilities');
END;
$$;

-- Establish four taxi players through real picks, not seeded taxi flags.
DO $$
DECLARE v_draft uuid; v_name text;
BEGIN
  v_draft:=(public.start_rookie_draft_atomic(pg_temp.taxi_id('life-league'),2,false,3600,'auto_pick')->>'id')::uuid;
  FOREACH v_name IN ARRAY ARRAY['life-activate','life-ir','life-drop','life-carry'] LOOP
    PERFORM public.make_snake_pick_atomic(v_draft,pg_temp.taxi_id('life-a'),pg_temp.taxi_id(v_name),true);
  END LOOP;
  PERFORM pg_temp.taxi_check((SELECT count(*)=4 FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league')
    AND member_id=pg_temp.taxi_id('life-a') AND is_on_taxi),'four real acquisitions establish lifecycle fixtures');
  PERFORM pg_temp.taxi_check((SELECT status='completed' FROM drafts WHERE id=v_draft)
    AND (SELECT status='active' FROM leagues WHERE id=pg_temp.taxi_id('life-league')),'taxi draft completion activates league');
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')),
    'first taxi acquisitions create no exit marks');
END;
$$;

-- Owner checks, activation, permanent exit, manual entry, and compound entry rollback.
DO $$
DECLARE v_activate uuid; v_ir uuid; v_drop uuid; v_manual uuid; v_before jsonb;
BEGIN
  SELECT id INTO STRICT v_activate FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league') AND player_id=pg_temp.taxi_id('life-activate');
  SELECT id INTO STRICT v_ir FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league') AND player_id=pg_temp.taxi_id('life-ir');
  SELECT id INTO STRICT v_drop FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league') AND player_id=pg_temp.taxi_id('life-drop');
  SELECT id INTO STRICT v_manual FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league') AND player_id=pg_temp.taxi_id('life-manual');
  PERFORM pg_temp.taxi_fails(format('SELECT public.toggle_taxi_atomic(%L,false,%L)',v_activate,pg_temp.taxi_id('user-outsider')),
    '42501','Not authorized','outsider cannot activate another roster');
  PERFORM pg_temp.taxi_check((SELECT is_on_taxi FROM roster_players WHERE id=v_activate)
    AND NOT EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-activate')),'unauthorized activation preserves taxi and exit state');
  PERFORM public.toggle_taxi_atomic(v_activate,false,pg_temp.taxi_id('user-a'));
  PERFORM pg_temp.taxi_check((SELECT NOT is_on_taxi AND NOT is_on_ir FROM roster_players WHERE id=v_activate)
    AND EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-activate')),'real activation creates permanent exit');
  PERFORM pg_temp.taxi_fails(format('SELECT public.toggle_taxi_atomic(%L,true,%L)',v_activate,pg_temp.taxi_id('user-a')),
    'P0001','only through a draft or trade','manual taxi reentry is denied');
  PERFORM pg_temp.taxi_fails(format('SELECT public.toggle_taxi_atomic(%L,true,%L)',v_manual,pg_temp.taxi_id('user-a')),
    'P0001','only through a draft or trade','manual first taxi entry is denied');
  PERFORM pg_temp.taxi_fails(format('UPDATE roster_players SET is_on_taxi=true WHERE id=%L',v_manual),
    'P0001','only through a draft or trade','direct status write cannot forge taxi entry');
  PERFORM pg_temp.taxi_fails(format('INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
    VALUES(%L,%L,%L,%L,''draft'',true)',pg_temp.taxi_id('snake-league'),pg_temp.taxi_id('snake-season'),
    pg_temp.taxi_id('snake-b'),pg_temp.taxi_id('life-manual')),
    'P0001','only through a draft or trade','draft provenance alone cannot forge taxi capability');
  PERFORM public.toggle_ir_atomic(v_ir,true,pg_temp.taxi_id('user-a'));
  PERFORM pg_temp.taxi_check((SELECT is_on_ir AND NOT is_on_taxi FROM roster_players WHERE id=v_ir)
    AND EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-ir')),'real taxi to IR move creates permanent exit');
  SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) INTO v_before FROM roster_players r WHERE r.id IN(v_ir,v_manual);
  PERFORM set_config('request.jwt.claim.sub',pg_temp.taxi_id('user-a')::text,true);
  PERFORM pg_temp.taxi_fails(format('SELECT public.activate_roster_player_with_overflow_atomic(%L,''ir'',%L,''taxi'')',v_ir,v_manual),
    'P0001','only through a draft or trade','overflow activation cannot create taxi entry');
  PERFORM pg_temp.taxi_fails(format('SELECT public.activate_roster_player_with_lineup_atomic(%L,''ir'',%L,''taxi'',%L,%L,%L,CURRENT_DATE,1,NULL)',
    v_ir,v_manual,pg_temp.taxi_id('life-a'),pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season')),
    'P0001','only through a draft or trade','lineup activation cannot create taxi entry');
  PERFORM pg_temp.taxi_check(v_before=(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM roster_players r WHERE r.id IN(v_ir,v_manual)),
    'both compound denials leave both roster rows unchanged');
  PERFORM public.drop_player_atomic(v_drop);
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM roster_players WHERE id=v_drop)
    AND EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-drop')),'real taxi drop creates permanent exit');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM waiver_wire_log WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-drop') AND cleared_at IS NULL)
    AND EXISTS(SELECT 1 FROM roster_transactions WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-drop') AND transaction_type='fa_drop'),'taxi drop preserves waiver and transaction rules');
END;
$$;

-- Server-only trade functions receive identity from Edge, rather than an end-user database session.
SELECT set_config('request.jwt.claim.sub','',true);

-- A receiving team chooses taxi before acceptance. Acceptance performs actual transfer and entry.
DO $$
DECLARE v_trade uuid; v_roster uuid; v_back uuid;
BEGIN
  v_trade:=public.propose_trade_atomic(pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),
    pg_temp.taxi_id('life-a'),pg_temp.taxi_id('life-b'),ARRAY[pg_temp.taxi_id('life-trade-in')],
    ARRAY[pg_temp.taxi_id('life-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM pg_temp.taxi_fails(format('SELECT public.set_trade_taxi_destinations_atomic(%L,%L,ARRAY[%L::uuid],%L)',
    v_trade,pg_temp.taxi_id('life-b'),pg_temp.taxi_id('life-trade-in'),pg_temp.taxi_id('user-outsider')),
    '42501','Not authorized','outsider cannot choose receiver taxi');
  PERFORM pg_temp.taxi_fails(format('SELECT public.set_trade_taxi_destinations_atomic(%L,%L,ARRAY[%L::uuid],%L)',
    v_trade,pg_temp.taxi_id('life-b'),pg_temp.taxi_id('life-return'),pg_temp.taxi_id('user-b')),
    '42501','receiving team','receiver cannot designate outgoing player');
  PERFORM public.set_trade_taxi_destinations_atomic(v_trade,pg_temp.taxi_id('life-b'),
    ARRAY[pg_temp.taxi_id('life-trade-in')],pg_temp.taxi_id('user-b'));
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM trade_items WHERE trade_id=v_trade
    AND player_id=pg_temp.taxi_id('life-trade-in') AND to_taxi),'real receiver selection records destination');
  PERFORM public.accept_trade_atomic(v_trade,pg_temp.taxi_id('life-b'));
  SELECT id INTO STRICT v_roster FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-trade-in') AND member_id=pg_temp.taxi_id('life-b');
  PERFORM pg_temp.taxi_check((SELECT status='completed' FROM trades WHERE id=v_trade)
    AND (SELECT is_on_taxi AND NOT is_on_ir AND acquired_via='trade' FROM roster_players WHERE id=v_roster),
    'real accepted trade delivers player directly to receiver taxi');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_transactions WHERE related_trade_id=v_trade
    AND player_id=pg_temp.taxi_id('life-trade-in') AND member_id=pg_temp.taxi_id('life-b') AND transaction_type='trade_in'),
    'taxi trade retains ordinary transfer history');
  PERFORM public.toggle_taxi_atomic(v_roster,false,pg_temp.taxi_id('user-b'));
  v_back:=public.propose_trade_atomic(pg_temp.taxi_id('life-league'),pg_temp.taxi_id('life-season'),
    pg_temp.taxi_id('life-b'),pg_temp.taxi_id('life-a'),ARRAY[pg_temp.taxi_id('life-trade-in')],
    ARRAY[pg_temp.taxi_id('life-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM pg_temp.taxi_fails(format('SELECT public.set_trade_taxi_destinations_atomic(%L,%L,ARRAY[%L::uuid],%L)',
    v_back,pg_temp.taxi_id('life-a'),pg_temp.taxi_id('life-trade-in'),pg_temp.taxi_id('user-a')),
    'P0001','left taxi and cannot return','permanent taxi exit blocks new receiving owner');
  PERFORM public.accept_trade_atomic(v_back,pg_temp.taxi_id('life-a'));
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-trade-in') AND member_id=pg_temp.taxi_id('life-a') AND NOT is_on_taxi)
    AND EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-trade-in')),'ordinary trade succeeds while permanent taxi exit follows player');
END;
$$;

-- Actual season rollover preserves continuing taxi and all previous exit marks.
DO $$
DECLARE v_new uuid; v_new_year int; v_trade uuid; v_drop_mark timestamptz;
BEGIN
  SELECT exited_at INTO STRICT v_drop_mark FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-drop');
  UPDATE leagues SET status='playoffs' WHERE id=pg_temp.taxi_id('life-league');
  PERFORM pg_temp.taxi_fails(format('SELECT public.advance_season_atomic(%L)',pg_temp.taxi_id('life-league')),
    'P0001','pending waiver claims and waiver holds','rollover still rejects outstanding waiver hold');
  -- Synthetic lifecycle setup: represent this exact hold after processing.
  -- This does not claim to execute or verify the global waiver processor.
  UPDATE waiver_wire_log SET cleared_at=now() WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-drop') AND cleared_at IS NULL;
  SELECT new_season_id,new_year INTO STRICT v_new,v_new_year FROM public.advance_season_atomic(pg_temp.taxi_id('life-league'));
  INSERT INTO taxi_acceptance_ids VALUES('life-new-season',v_new);
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_new
    AND player_id=pg_temp.taxi_id('life-carry') AND is_on_taxi AND acquired_via='carry_over')
    AND NOT EXISTS(SELECT 1 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
    AND player_id=pg_temp.taxi_id('life-carry')),'real rollover keeps continuous taxi without marking exit');
  PERFORM pg_temp.taxi_check((SELECT count(*)=4 FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league'))
    AND (SELECT exited_at=v_drop_mark FROM league_player_taxi_exits WHERE league_id=pg_temp.taxi_id('life-league')
      AND player_id=pg_temp.taxi_id('life-drop')),'rollover preserves all activation IR drop and trade exit marks');
  v_trade:=public.propose_trade_atomic(pg_temp.taxi_id('life-league'),v_new,
    pg_temp.taxi_id('life-a'),pg_temp.taxi_id('life-b'),ARRAY[pg_temp.taxi_id('life-trade-in')],
    ARRAY[pg_temp.taxi_id('life-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM pg_temp.taxi_fails(format('SELECT public.set_trade_taxi_destinations_atomic(%L,%L,ARRAY[%L::uuid],%L)',
    v_trade,pg_temp.taxi_id('life-b'),pg_temp.taxi_id('life-trade-in'),pg_temp.taxi_id('user-b')),
    'P0001','left taxi and cannot return','trade acquisition cannot erase exit after real rollover');
  PERFORM public.accept_trade_atomic(v_trade,pg_temp.taxi_id('life-b'));
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=v_new
    AND player_id=pg_temp.taxi_id('life-trade-in') AND member_id=pg_temp.taxi_id('life-b') AND NOT is_on_taxi),
    'ordinary new-season trade remains valid after taxi refusal');
END;
$$;

-- Actual auction start, nomination, authorized bid, and close acquire directly into taxi.
DO $$
DECLARE v_draft uuid; v_nom nominations%ROWTYPE; v_stale nominations%ROWTYPE; v_bid_count int; v_budget int;
BEGIN
  SELECT id INTO v_draft FROM public.start_auction_draft_atomic(pg_temp.taxi_id('auction-league'),'user_nominated',false,3600,100,'auction_no_bid');
  INSERT INTO taxi_acceptance_ids VALUES('auction-draft',v_draft);
  v_nom:=public.create_auction_nomination_atomic(v_draft,pg_temp.taxi_id('auction-a'),
    pg_temp.taxi_id('auction-sale'),pg_temp.taxi_id('user-a'),3600);
  PERFORM pg_temp.taxi_fails(format('SELECT public.place_auction_bid_atomic(%L,%L,%L,5,%L,true)',
    v_draft,pg_temp.taxi_id('auction-b'),v_nom.id,pg_temp.taxi_id('user-outsider')),
    '42501','Not authorized','auction bid preserves actor ownership');
  PERFORM public.place_auction_bid_atomic(v_draft,pg_temp.taxi_id('auction-b'),v_nom.id,5,pg_temp.taxi_id('user-b'),true);
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM bids WHERE nomination_id=v_nom.id
    AND member_id=pg_temp.taxi_id('auction-b') AND amount=5 AND to_taxi),'real auction bid saves taxi choice');
  UPDATE nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=v_nom.id;
  PERFORM pg_temp.taxi_check(public.close_auction_nomination_atomic(v_nom.id),'actual auction close handles expired timer');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM nominations WHERE id=v_nom.id AND status='sold' AND final_price=5
    AND winning_member_id=pg_temp.taxi_id('auction-b')),'auction settles real winner');
  PERFORM pg_temp.taxi_check(EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('auction-league')
    AND player_id=pg_temp.taxi_id('auction-sale') AND member_id=pg_temp.taxi_id('auction-b')
    AND is_on_taxi AND acquisition_cost=5),'auction close acquires directly into taxi');
  PERFORM pg_temp.taxi_check((SELECT remaining=95 FROM draft_budgets WHERE draft_id=v_draft
    AND member_id=pg_temp.taxi_id('auction-b')),'auction charges only settled price');
  PERFORM pg_temp.taxi_check(NOT public.close_auction_nomination_atomic(v_nom.id)
    AND (SELECT remaining=95 FROM draft_budgets WHERE draft_id=v_draft AND member_id=pg_temp.taxi_id('auction-b')),
    'auction retry cannot duplicate charge or acquisition');

  v_stale:=public.create_auction_nomination_atomic(v_draft,pg_temp.taxi_id('auction-b'),
    pg_temp.taxi_id('auction-stale'),pg_temp.taxi_id('user-b'),3600);
  SELECT count(*) INTO v_bid_count FROM bids WHERE nomination_id=v_stale.id;
  PERFORM pg_temp.taxi_fails(format('SELECT public.place_auction_bid_atomic(%L,%L,%L,5,%L,true)',
    v_draft,pg_temp.taxi_id('auction-b'),v_stale.id,pg_temp.taxi_id('user-b')),
    'P0001','taxi squad is full','full auction taxi rejects bid');
  PERFORM pg_temp.taxi_check((SELECT count(*)=v_bid_count FROM bids WHERE nomination_id=v_stale.id)
    AND (SELECT current_bid_amount=0 AND current_bidder_id IS NULL FROM nominations WHERE id=v_stale.id),
    'rejected auction taxi bid preserves bid history and nomination');
  PERFORM public.place_auction_bid_atomic(v_draft,pg_temp.taxi_id('auction-a'),v_stale.id,5,pg_temp.taxi_id('user-a'),true);
  SELECT remaining INTO STRICT v_budget FROM draft_budgets WHERE draft_id=v_draft AND member_id=pg_temp.taxi_id('auction-a');
  -- Simulate a metadata refresh on this synthetic athlete after bidding, before settlement.
  UPDATE players SET years_exp=1 WHERE id=pg_temp.taxi_id('auction-stale');
  UPDATE nominations SET countdown_expires_at=now()-interval '1 second' WHERE id=v_stale.id;
  PERFORM pg_temp.taxi_check(public.close_auction_nomination_atomic(v_stale.id),'auction close resolves changed taxi eligibility');
  PERFORM pg_temp.taxi_check((SELECT status='no_bid' AND winning_member_id IS NULL FROM nominations WHERE id=v_stale.id)
    AND (SELECT remaining=v_budget FROM draft_budgets WHERE draft_id=v_draft AND member_id=pg_temp.taxi_id('auction-a'))
    AND NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('auction-league')
      AND player_id=pg_temp.taxi_id('auction-stale')),'changed auction eligibility creates no award or budget charge');
END;
$$;

-- A changed taxi precondition yields the queue's terminal signal, with all transfer writes rolled back.
-- Exact-trade functions avoid touching any preexisting accepted-trade queue.
DO $$
DECLARE v_trade uuid; v_healthy uuid; v_before jsonb;
BEGIN
  v_trade:=public.propose_trade_atomic(pg_temp.taxi_id('late-league'),pg_temp.taxi_id('late-season'),
    pg_temp.taxi_id('late-a'),pg_temp.taxi_id('late-b'),ARRAY[pg_temp.taxi_id('late-offer')],
    ARRAY[pg_temp.taxi_id('late-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM public.set_trade_taxi_destinations_atomic(v_trade,pg_temp.taxi_id('late-b'),
    ARRAY[pg_temp.taxi_id('late-offer')],pg_temp.taxi_id('user-b'));
  PERFORM public.accept_trade_atomic(v_trade,pg_temp.taxi_id('late-b'));
  PERFORM pg_temp.taxi_check((SELECT status='accepted' AND completed_at IS NULL FROM trades WHERE id=v_trade),
    'real accepted trade waits for its configured veto window');
  -- Time and metadata changes affect only new fixtures; acquisition success is never seeded.
  UPDATE trades SET veto_window_expires_at=now()-interval '1 second' WHERE id=v_trade;
  UPDATE players SET years_exp=1 WHERE id=pg_temp.taxi_id('late-offer');
  SELECT jsonb_build_object('rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM roster_players r
    WHERE league_id=pg_temp.taxi_id('late-league')),'trade',to_jsonb(t)) INTO v_before FROM trades t WHERE id=v_trade;
  PERFORM pg_temp.taxi_fails(format('SELECT public.complete_accepted_trade_atomic(%L)',v_trade),
    'PT001','Taxi acquisition failed: Only current rookies','changed trade taxi eligibility yields terminal queue signal');
  PERFORM pg_temp.taxi_check(v_before=(SELECT jsonb_build_object('rosters',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
    FROM roster_players r WHERE league_id=pg_temp.taxi_id('late-league')),'trade',to_jsonb(t)) FROM trades t WHERE id=v_trade),
    'failed late taxi trade rolls back every roster and lifecycle write');
  PERFORM pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM roster_transactions WHERE related_trade_id=v_trade),
    'failed late trade creates no partial transfer history');
  PERFORM public.expire_trade_completion_failure_atomic(v_trade,'Synthetic taxi precondition changed');
  PERFORM pg_temp.taxi_check((SELECT status='expired' AND completion_failure_reason IS NOT NULL FROM trades WHERE id=v_trade),
    'exact terminal failure releases accepted trade reservations');
  UPDATE leagues SET trade_veto_mode='disabled',trade_veto_window_hours=0 WHERE id=pg_temp.taxi_id('late-league');
  v_healthy:=public.propose_trade_atomic(pg_temp.taxi_id('late-league'),pg_temp.taxi_id('late-season'),
    pg_temp.taxi_id('late-a'),pg_temp.taxi_id('late-b'),ARRAY[pg_temp.taxi_id('late-offer')],
    ARRAY[pg_temp.taxi_id('late-return')],ARRAY[]::uuid[],ARRAY[]::uuid[]);
  PERFORM public.accept_trade_atomic(v_healthy,pg_temp.taxi_id('late-b'));
  PERFORM pg_temp.taxi_check((SELECT status='completed' FROM trades WHERE id=v_healthy)
    AND EXISTS(SELECT 1 FROM roster_players WHERE league_id=pg_temp.taxi_id('late-league')
      AND player_id=pg_temp.taxi_id('late-offer') AND member_id=pg_temp.taxi_id('late-b') AND NOT is_on_taxi),
    'healthy ordinary trade succeeds after terminal taxi failure');
END;
$$;

-- Every capability is consumed or rolled back. No synthetic world retains one at completion.
SELECT pg_temp.taxi_check(NOT EXISTS(SELECT 1 FROM private.taxi_acquisition_context
  WHERE league_id IN(pg_temp.taxi_id('snake-league'),pg_temp.taxi_id('life-league'),
    pg_temp.taxi_id('auction-league'),pg_temp.taxi_id('late-league'))),
  'all real acquisitions consume temporary taxi capabilities');
SELECT 'taxi acceptance checks passed; rolling back all fixtures' AS result,count(*) AS checks FROM taxi_acceptance_checks;
ROLLBACK;
