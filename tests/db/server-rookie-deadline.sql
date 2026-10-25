BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  draft uuid;
  game uuid;
  players uuid[];
  newest uuid;
  slots int;
BEGIN
  FOR slots IN 0..1 LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(2, 9500 + slots, 'drafting');
    draft := gen_random_uuid();
    game := gen_random_uuid();
    players := ARRAY[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
    UPDATE public.leagues SET roster_size = 1, taxi_slots = slots WHERE id = f.league_id;
    INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES(game, '002950000' || slots, 9500 + slots, 1, (now() AT TIME ZONE 'America/New_York')::date + 1, 'RDA', 'RDB', 'Scheduled');
    INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp, nba_draft_number)
    SELECT id, 'Deadline', id::text, 'PG', ARRAY['PG'], CASE WHEN ord IN (1, 4) THEN 4 ELSE 0 END, 1
    FROM unnest(players) WITH ORDINALITY AS player(id, ord);
    INSERT INTO public.drafts(id, league_id, league_season_id, draft_type, status, is_mock, rounds)
    VALUES(draft, f.league_id, f.season_id, 'snake', 'completed', false, 2);
    INSERT INTO public.snake_draft_picks(draft_id, overall_pick, round, pick_in_round, member_id, player_id, picked_at)
    VALUES(draft, 1, 1, 1, f.member_ids[1], players[2], now() - interval '2 minutes'),
      (draft, 2, 1, 2, f.member_ids[2], players[5], now() - interval '1 minute'),
      (draft, 3, 2, 1, f.member_ids[1], players[3], now());
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT f.league_id, f.season_id, f.member_ids[CASE WHEN ord <= 3 THEN 1 ELSE 2 END], id, 'draft'
    FROM unnest(players) WITH ORDINALITY AS player(id, ord);
    PERFORM pg_temp.check_rules(NOT public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'overflow waits before opening night with taxi slots ' || slots);
    UPDATE public.nba_games SET game_date = (now() AT TIME ZONE 'America/New_York')::date - 1 WHERE id = game;
    PERFORM pg_temp.check_rules(public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'opening night activates despite remaining overflow with taxi slots ' || slots);
    PERFORM pg_temp.check_rules((SELECT status = 'active' FROM public.leagues WHERE id = f.league_id),
      'deadline leaves the league active with taxi slots ' || slots);
    PERFORM pg_temp.check_rules((SELECT count(*) = slots * 2 FROM public.roster_players
      WHERE league_season_id = f.season_id AND is_on_taxi), 'deadline respects taxi capacity ' || slots);
    IF slots = 1 THEN
      PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM public.roster_players
        WHERE league_season_id = f.season_id AND player_id = players[3])
        AND NOT (SELECT is_on_taxi FROM public.roster_players WHERE league_season_id = f.season_id AND player_id = players[2]),
        'deadline moves the newest drafted rookie first');
    END IF;
    PERFORM pg_temp.reject_rules(format('SELECT private.assert_roster_within_active_limit(%L,%L,%L)',
      f.league_id, f.season_id, f.member_ids[1]), '%active player limit%', 'deadline overflow still blocks roster edits with slots ' || slots);
    PERFORM pg_temp.check_rules(NOT public.activate_rookie_draft_league_atomic(p_draft_id => draft),
      'deadline activation is idempotent with taxi slots ' || slots);
  END LOOP;
END;
$$;
DO $$
DECLARE f record; players uuid[]; draft uuid; game uuid; offer uuid; mode int;
BEGIN
  FOR mode IN 1..2 LOOP
    SELECT * INTO f FROM pg_temp.rules_fixture(3,9530+mode,'active');
    UPDATE leagues SET roster_size=4,taxi_slots=1,allow_inactive_trades=true WHERE id=f.league_id;
    players:=ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number)
      SELECT id,'Reserved',id::text,'PG',ARRAY['PG'],CASE WHEN n<=3 THEN 0 ELSE 4 END,1 FROM unnest(players) WITH ORDINALITY p(id,n);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      SELECT f.league_id,f.season_id,f.member_ids[CASE WHEN n<=3 THEN 1 WHEN n=4 THEN 2 ELSE 3 END],players[n],'draft' FROM generate_series(1,6) n;
    draft:=gen_random_uuid(); game:=gen_random_uuid();
    INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
      VALUES(draft,f.league_id,f.season_id,'snake','completed',false,3);
    INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
      SELECT draft,n,n,1,f.member_ids[1],players[n],now() FROM generate_series(1,3) n;
    IF mode=1 THEN
      offer:=public.submit_trade_offer_atomic(f.user_ids[1],gen_random_uuid(),f.member_ids[1],'propose',
        jsonb_build_object('leagueId',f.league_id,'leagueSeasonId',f.season_id,'recipientMemberId',f.member_ids[2],
          'offerPlayerIds',ARRAY[players[1]],'requestPlayerIds',ARRAY[players[4]],
          'rosterPlan',jsonb_build_object('taxiPlayerIds','[]'::jsonb,'irPlayerIds','[]'::jsonb,'dropPlayerIds',ARRAY[players[3]])));
    ELSE
      offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[3]],ARRAY[players[4]],'{}','{}');
      PERFORM public.accept_trade_atomic(offer,f.member_ids[2]);
    END IF;
    UPDATE leagues SET status='drafting',roster_size=1 WHERE id=f.league_id;
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(game,'002953000'||mode,9530+mode,1,(now() AT TIME ZONE 'America/New_York')::date-1,'RDA','RDB','Scheduled');
    PERFORM pg_temp.check_rules(public.activate_rookie_draft_league_atomic(draft),'reserved rookie still permits deadline activation '||mode);
    PERFORM pg_temp.check_rules((SELECT status='active' FROM leagues WHERE id=f.league_id),'reserved rookie leaves league active '||mode);
    PERFORM pg_temp.check_rules((SELECT NOT is_on_taxi FROM roster_players WHERE league_season_id=f.season_id AND player_id=players[3]),
      'newest reserved rookie stays in place '||mode);
    PERFORM pg_temp.check_rules((SELECT is_on_taxi FROM roster_players WHERE league_season_id=f.season_id AND player_id=players[2]),
      'next unreserved rookie moves to taxi '||mode);
    PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
    PERFORM public.drop_player_atomic((SELECT id FROM roster_players WHERE league_season_id=f.season_id AND player_id=players[6]),f.season_id,NULL);
    PERFORM set_config('request.jwt.claim.sub','',true);
    PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM roster_players WHERE league_season_id=f.season_id AND player_id=players[6]),
      'another member can drop after deadline activation '||mode);
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
