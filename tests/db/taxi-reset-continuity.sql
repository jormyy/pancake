-- A commissioner's draft reset undoes the draft; it is not the team moving its rookie out of taxi.
-- The same team must be able to draft that rookie into taxi again, while a real team exit survives the reset.
BEGIN;
DO $$
DECLARE
  v_user uuid := gen_random_uuid(); v_league uuid := gen_random_uuid(); v_member uuid := gen_random_uuid();
  v_season uuid := gen_random_uuid(); v_draft uuid := gen_random_uuid();
  v_kept uuid := gen_random_uuid(); v_moved uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
  INSERT INTO leagues(id,name,slug,commissioner_id,status,taxi_slots)
  VALUES(v_league,'Taxi reset continuity',v_league::text,v_user,'active',2);
  INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(v_member,v_league,v_user,'commissioner','Reset Team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(v_season,v_league,2161,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number,nba_team)
  VALUES(v_kept,'Reset','Taxi Kept','PG',ARRAY['PG'],0,1,'ZRA'),(v_moved,'Reset','Taxi Moved','SG',ARRAY['SG'],0,2,'ZRB');
  INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds)
  VALUES(v_draft,v_league,v_season,'snake','completed',false,1);
  INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,player_id,picked_at)
  VALUES(v_draft,1,1,1,v_member,v_kept,now()),(v_draft,2,1,2,v_member,v_moved,now());
  -- Both rookies were drafted straight into taxi (the draft acquisition context the pick functions record).
  INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
  VALUES(pg_current_xact_id(),v_league,v_season,v_member,v_kept,'draft',v_draft),(pg_current_xact_id(),v_league,v_season,v_member,v_moved,'draft',v_draft);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
  VALUES(v_league,v_season,v_member,v_kept,'draft',true),(v_league,v_season,v_member,v_moved,'draft',true);
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id();
  -- The team itself moves one rookie out of taxi: that exit is real and must survive the reset.
  UPDATE roster_players SET is_on_taxi=false WHERE league_id=v_league AND player_id=v_moved;
  IF NOT EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_league AND member_id=v_member AND player_id=v_moved) THEN
    RAISE EXCEPTION 'Control: a team moving a rookie out of taxi records no exit';
  END IF;

  PERFORM reset_draft_atomic(v_draft,v_user);

  IF EXISTS(SELECT 1 FROM roster_players WHERE league_id=v_league) THEN
    RAISE EXCEPTION 'Reset kept drafted roster rows';
  END IF;
  IF EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_league AND member_id=v_member AND player_id=v_kept) THEN
    RAISE EXCEPTION 'REPRODUCED: a draft reset records a permanent taxi exit for the drafting team';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM league_member_taxi_exits WHERE league_id=v_league AND member_id=v_member AND player_id=v_moved) THEN
    RAISE EXCEPTION 'Reset erased a real team taxi exit';
  END IF;
  -- The re-run draft can place the reset rookie into the same team's taxi again.
  INSERT INTO private.taxi_acquisition_context(transaction_id,league_id,league_season_id,member_id,player_id,source,related_id)
  VALUES(pg_current_xact_id(),v_league,v_season,v_member,v_kept,'draft',v_draft);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_taxi)
  VALUES(v_league,v_season,v_member,v_kept,'draft',true);
  IF NOT EXISTS(SELECT 1 FROM roster_players WHERE league_id=v_league AND player_id=v_kept AND is_on_taxi) THEN
    RAISE EXCEPTION 'The reset rookie could not return to the same team''s taxi';
  END IF;
END;
$$;
ROLLBACK;
