BEGIN;
\ir rules-support.sql
DO $$
DECLARE
  f record;
  players uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  roster_ids uuid[] := ARRAY[]::uuid[];
  roster_id uuid;
  trade_id uuid;
  claim_id uuid;
  game_id uuid := gen_random_uuid();
  tipoff timestamptz := now() + interval '10 minutes';
  token uuid := gen_random_uuid();
  game_date date := (now() AT TIME ZONE 'America/New_York')::date;
  assignments jsonb;
  snapshot jsonb;
  i integer;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9394);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9394,1,game_date-1,game_date+5);
  UPDATE public.leagues SET ir_slots=2,taxi_slots=2,allow_inactive_trades=true WHERE id=f.league_id;
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,years_exp)
    SELECT id,'Lineup reservation',ordinal::text,'PG',ARRAY['PG','SG'],'ZLH',0
      FROM unnest(players) WITH ORDINALITY ids(id,ordinal);
  FOR i IN 1..3 LOOP
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(f.league_id,f.season_id,f.member_ids[CASE WHEN i=3 THEN 2 ELSE 1 END],players[i],'draft')
      RETURNING id INTO roster_id;
    roster_ids := array_append(roster_ids,roster_id);
  END LOOP;
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game_id,'lineup-reservation-'||game_id,9394,1,game_date,tipoff,'ZLH','ZLA','Scheduled');
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count)
    VALUES(f.league_id,'PG',1),(f.league_id,'SG',1),(f.league_id,'BE',5)
    ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=EXCLUDED.slot_count;
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],1,game_date,'PG');
  trade_id := public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[1]],ARRAY[players[3]],'{}','{}');
  claim_id := public.create_waiver_claim_atomic(f.league_id,f.member_ids[1],players[4],players[2]);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM private.locked_assets(f.league_id,f.season_id,f.member_ids[1])), 'trade and claim reservations exist');

  PERFORM public.set_player_slot_moves_atomic(f.member_ids[1],f.league_id,f.season_id,game_date,1,
    jsonb_build_array(jsonb_build_object('player_id',players[1],'slot_type','BE'),jsonb_build_object('player_id',players[2],'slot_type','PG')));
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE player_id=players[1])
    AND EXISTS(SELECT 1 FROM public.weekly_lineups WHERE player_id=players[2] AND slot_type='PG'), 'manual swap moves reserved starter to bench and claim drop player to starter');

  assignments := jsonb_build_array(jsonb_build_object('player_id',players[1],'slot_type','SG'),jsonb_build_object('player_id',players[2],'slot_type','PG'));
  PERFORM public.auto_set_lineup_atomic(f.member_ids[1],f.league_id,f.season_id,game_date,assignments);
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE player_id=players[1] AND slot_type='SG'), 'auto-set places reserved player in selected better lineup');
  snapshot := public.view_lineup(f.league_id,f.member_ids[1],jsonb_build_object('date',game_date));
  PERFORM pg_temp.check_rules(snapshot->'lockedAssets'='[]'::jsonb,'lineup snapshot omits reservation messages');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'starters') slot
    WHERE jsonb_array_length(slot->'player'->'assetLocks')>0), 'lineup starter rows omit reservation locks');
  PERFORM public.set_player_slot_atomic(f.member_ids[1],f.league_id,f.season_id,players[1],game_date,'BE',1);
  snapshot := public.view_lineup(f.league_id,f.member_ids[1],jsonb_build_object('date',game_date));
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot->'bench') player
    WHERE player->>'playerId'=players[1]::text AND player->'assetLocks'='[]'::jsonb), 'lineup bench rows omit reservation locks');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_roster(f.league_id,f.member_ids[1])->'lockedAssets')=3, 'roster retains reservation messages');

  UPDATE public.lineup_optimizer_settings SET enabled=true WHERE member_id=f.member_ids[1] AND league_season_id=f.season_id;
  snapshot := public.get_pre_tipoff_lineup_context(f.league_id,f.season_id,f.member_ids[1]);
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM jsonb_array_elements(snapshot->'players') player
    WHERE (player->>'locked')::boolean=false AND (player->>'hasGame')::boolean), 'optimizer includes both reserved players without reservation locks');
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
    VALUES(tipoff,game_date,'queued',token,now()+interval '1 minute');
  PERFORM pg_temp.check_rules(public.claim_lineup_tipoff_dispatch(tipoff,token)=game_date, 'pre-tipoff optimizer dispatch claimed');
  PERFORM pg_temp.check_rules(public.apply_pre_tipoff_lineup(tipoff,token,f.league_id,f.season_id,f.member_ids[1],assignments), 'pre-tipoff optimizer applies reserved players');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.lineup_tipoff_members WHERE tipoff_at=tipoff AND member_id=f.member_ids[1])
    AND EXISTS(SELECT 1 FROM public.weekly_lineups WHERE player_id=players[1] AND slot_type='SG'), 'optimizer records completion and reserved player placement');

  FOR i IN 1..2 LOOP
    PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)',roster_ids[i]),
      CASE WHEN i=1 THEN 'Locked by trade '||left(trade_id::text,8)||'.%' ELSE 'Locked by waiver claim '||left(claim_id::text,8)||'.%' END, 'reserved drop remains blocked '||i);
    PERFORM pg_temp.reject_rules(format('DELETE FROM public.roster_players WHERE id=%L',roster_ids[i]),
      'Locked by %', 'direct roster removal remains blocked '||i);
    PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_ir=true WHERE id=%L',roster_ids[i]),
      'Locked by %', 'IR status guard remains '||i);
    PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_taxi=true WHERE id=%L',roster_ids[i]),
      'Locked by %', 'Taxi status guard remains '||i);
    PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET member_id=%L WHERE id=%L',f.member_ids[2],roster_ids[i]),
      'Locked by %', 'ownership guard remains '||i);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM public.accept_trade_atomic(trade_id,f.member_ids[2]);
  PERFORM pg_temp.check_rules((SELECT status='accepted' FROM public.trades WHERE id=trade_id), 'accepted trade reservation exists');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.drop_player_atomic(%L)',roster_ids[1]),
    'Locked by trade %', 'accepted trade drop remains blocked');
  PERFORM pg_temp.reject_rules(format('DELETE FROM public.roster_players WHERE id=%L',roster_ids[1]),
    'Locked by trade %', 'accepted trade direct removal remains blocked');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_ir=true WHERE id=%L',roster_ids[1]),
    'Locked by trade %', 'accepted trade IR move remains blocked');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET is_on_taxi=true WHERE id=%L',roster_ids[1]),
    'Locked by trade %', 'accepted trade taxi move remains blocked');
  PERFORM pg_temp.reject_rules(format('UPDATE public.roster_players SET member_id=%L WHERE id=%L',f.member_ids[2],roster_ids[1]),
    'Locked by trade %', 'accepted trade ownership change remains blocked');
  UPDATE public.nba_games SET game_time=now()-interval '1 minute',status='InProgress' WHERE id=game_id;
  PERFORM pg_temp.reject_rules(format('SELECT public.set_player_slot_atomic(%L,%L,%L,%L,%L,''BE'',1)',f.member_ids[1],f.league_id,f.season_id,players[1],game_date),
    '%game has already started%', 'manual game-time lock remains');
  PERFORM pg_temp.reject_rules(format('SELECT public.auto_set_lineup_atomic(%L,%L,%L,%L,''[]''::jsonb)',f.member_ids[1],f.league_id,f.season_id,game_date),
    '%game has already started%', 'auto-set game-time lock remains');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
