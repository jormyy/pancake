BEGIN;
DELETE FROM private.player_roster_cycle_state WHERE singleton;
DO $$
DECLARE v_espn jsonb; v_nba jsonb; v_start timestamptz:=now()-interval '4 days';
  v_stale uuid:=gen_random_uuid(); v_held uuid:=gen_random_uuid(); v_listed uuid; v_merged uuid:=gen_random_uuid(); v_i integer; v_id uuid; v_team text;
  v_codes text[]:=ARRAY['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'];
BEGIN
  v_espn:='[]'; v_nba:='[]';
  FOR v_i IN 1..360 LOOP
    v_team:=v_codes[1+(v_i%30)];
    INSERT INTO players(first_name,last_name,nba_team,espn_id,nba_id)
      VALUES('Cycle',v_i::text,v_team,'cycle-espn-'||v_i,'cycle-nba-'||v_i) RETURNING id INTO v_id;
    v_espn:=v_espn||jsonb_build_array(jsonb_build_object('provider_id','cycle-espn-'||v_i,'nba_team',v_team));
    v_nba:=v_nba||jsonb_build_array(jsonb_build_object('provider_id','cycle-nba-'||v_i,'nba_team',v_team));
  END LOOP;
  INSERT INTO players(id,first_name,last_name,nba_team) VALUES(v_stale,'Stale','Roster','BOS'),(v_held,'Positive','Box','BOS');
  PERFORM complete_player_roster_cycle_atomic(p_espn_records=>v_espn,p_nba_records=>v_nba,p_started_at=>v_start);
  IF (SELECT nba_team FROM players WHERE id=v_stale)<>'BOS' THEN RAISE EXCEPTION 'First absence clears a team'; END IF;
  SELECT id INTO v_listed FROM players WHERE espn_id='cycle-espn-1';
  INSERT INTO players(id,first_name,last_name) VALUES(v_merged,'Cycle','1');
  PERFORM merge_players(v_merged,v_listed);
  IF (SELECT count(*) FROM private.player_roster_presence WHERE provider_id IN ('cycle-espn-1','cycle-nba-1'))<>2 THEN
    RAISE EXCEPTION 'A player merge loses current source roster evidence';
  END IF;
  INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002cycleheld',2027,1,(v_start+interval '6 hours')::date,v_start+interval '6 hours','BOS','MIN','Final') RETURNING id INTO v_id;
  INSERT INTO private.player_game_memberships(player_id,game_id,nba_team) VALUES(v_held,v_id,'BOS');
  PERFORM complete_player_roster_cycle_atomic(p_espn_records=>v_espn,p_nba_records=>v_nba,p_started_at=>v_start+interval '25 hours');
  IF (SELECT nba_team FROM players WHERE id=v_stale) IS NOT NULL THEN RAISE EXCEPTION 'A full cycle of dual-source absence retains a stale team'; END IF;
  IF EXISTS(SELECT FROM search_players(p_query=>'Stale Roster',p_teams=>ARRAY['BOS'])) THEN RAISE EXCEPTION 'The team-filtered Players list still shows a stale roster row'; END IF;
  IF NOT EXISTS(SELECT FROM search_players(p_query=>'Stale Roster')) THEN RAISE EXCEPTION 'Unassigned player history disappears from the existing free-agent list'; END IF;
  IF (SELECT nba_team FROM players WHERE id=v_held)<>'BOS' THEN RAISE EXCEPTION 'A current box no longer protects an omitted roster player'; END IF;
  IF (SELECT count(*) FROM private.player_roster_presence)<>720 THEN RAISE EXCEPTION 'Complete current roster evidence is missing'; END IF;
  SELECT id INTO v_listed FROM players WHERE espn_id='cycle-espn-1';
  PERFORM complete_player_roster_cycle_atomic(v_espn-0,v_nba,v_start+interval '26 hours');
  IF (SELECT nba_team FROM players WHERE id=v_listed) IS NULL THEN RAISE EXCEPTION 'One-source omission clears a currently listed player'; END IF;
  BEGIN
    PERFORM complete_player_roster_cycle_atomic(v_espn,'[]',v_start+interval '27 hours');
    RAISE EXCEPTION 'Partial source accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  IF (SELECT nba_team FROM players WHERE id=v_held)<>'BOS' THEN RAISE EXCEPTION 'Partial source clears a held team'; END IF;
  IF NOT (complete_player_roster_cycle_atomic(v_espn,v_nba,v_start)->>'stale')::boolean THEN RAISE EXCEPTION 'An older cycle overwrites current evidence'; END IF;
END $$;
ROLLBACK;
SELECT 'roster cycle: 10 checks PASS';
