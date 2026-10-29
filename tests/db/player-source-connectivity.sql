BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_a uuid:=gen_random_uuid(); v_b uuid:=gen_random_uuid(); v_c uuid:=gen_random_uuid(); v_result jsonb; v_owner uuid:=gen_random_uuid(); v_named uuid:=gen_random_uuid(); v_conflict_owner uuid:=gen_random_uuid(); v_conflict_candidate uuid:=gen_random_uuid();
BEGIN
  INSERT INTO players(id,first_name,last_name,nba_team,nba_id,years_exp,position)
    VALUES(v_a,'FixtureAaron','Holiday','HOU','connect-nba-aaron',NULL,NULL),
      (v_b,'FixtureDalano','Banton','POR','connect-nba-dalano',4,'PG'),
      (v_c,'FixtureAlex','Antetokounmpo','MIL',NULL,NULL,NULL);
  v_result:=link_player_sources_atomic(p_source=>'espn',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-espn-aaron','display_name','FixtureAaron-Holiday','nba_team','HOU','years_exp',8,'position','PG')),p_current_roster=>false);
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_a OR NOT EXISTS(
    SELECT FROM players WHERE id=v_a AND espn_id='connect-espn-aaron' AND nba_id='connect-nba-aaron' AND years_exp=8 AND position='PG') THEN
    RAISE EXCEPTION 'ESPN name and team match remains disconnected';
  END IF;
  PERFORM link_player_sources_atomic(p_source=>'sleeper',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-sleeper-dalano','display_name','FixtureDalano Banton','nba_team','POR','years_exp',1,'position','SF')),p_current_roster=>false);
  IF NOT EXISTS(SELECT FROM players WHERE id=v_b AND sleeper_id='connect-sleeper-dalano' AND years_exp=4 AND position='PG') THEN
    RAISE EXCEPTION 'Sleeper identity or established metadata is lost';
  END IF;
  PERFORM link_player_sources_atomic(p_source=>'nba',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-nba-alex','display_name','FixtureAlex Antetokounmpo','nba_team','MIL','years_exp',0,'position','F')),p_current_roster=>false);
  IF NOT EXISTS(SELECT FROM players WHERE id=v_c AND nba_id='connect-nba-alex' AND years_exp=0 AND position='F') THEN
    RAISE EXCEPTION 'NBA roster match remains disconnected';
  END IF;
  v_result:=link_player_sources_atomic(p_source=>'espn',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-conflict','display_name','FixtureAaron Holiday','nba_team','HOU')),p_current_roster=>false);
  IF v_result->'results'->0->>'action'<>'ambiguous' OR EXISTS(SELECT FROM players WHERE espn_id='connect-conflict') THEN
    RAISE EXCEPTION 'A different non-null provider identity is overwritten';
  END IF;
  INSERT INTO players(first_name,last_name,nba_team) VALUES('FixtureAmbiguous','Source','SAS'),('FixtureAmbiguous','Source','SA');
  v_result:=link_player_sources_atomic(p_source=>'espn',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-ambiguous','display_name','FixtureAmbiguous Source','nba_team','SAS')),p_current_roster=>false);
  IF v_result->'results'->0->>'action'<>'ambiguous' OR EXISTS(SELECT FROM players WHERE espn_id='connect-ambiguous') THEN
    RAISE EXCEPTION 'FixtureAmbiguous source match creates or links a player';
  END IF;
  v_result:=link_player_sources_atomic(p_source=>'sleeper',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-wrong-team','display_name','FixtureAlex Antetokounmpo','nba_team','BOS')),p_current_roster=>false);
  IF v_result->'results'->0->>'action'<>'missing' OR EXISTS(SELECT FROM players WHERE sleeper_id='connect-wrong-team') THEN
    RAISE EXCEPTION 'A source links across NBA teams';
  END IF;
  v_result:=link_player_sources_atomic(p_source=>'sleeper',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connect-other-conflict','display_name','FixtureAlex Antetokounmpo','nba_team','MIL','nba_id','wrong-nba')),p_current_roster=>false);
  IF v_result->'results'->0->>'action'<>'ambiguous' OR EXISTS(SELECT FROM players WHERE sleeper_id='connect-other-conflict') THEN
    RAISE EXCEPTION 'Other source identities conflict during linking';
  END IF;
  INSERT INTO players(id,first_name,last_name,nba_team,nba_id,espn_id) VALUES
    (v_owner,'FixtureJakob','Pöltl',NULL,'connected-poeltl',NULL),(v_named,'FixtureJakob','Poeltl','TOR',NULL,'connected-poeltl-espn');
  PERFORM link_player_sources_atomic(p_source=>'nba',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','connected-poeltl','display_name','FixtureJakob Poeltl','nba_team','TOR')),p_current_roster=>false);
  IF EXISTS(SELECT FROM players WHERE id=v_named) OR NOT EXISTS(SELECT FROM players WHERE id=v_owner
    AND nba_id='connected-poeltl' AND espn_id='connected-poeltl-espn') THEN
    RAISE EXCEPTION 'A source-owned box row stays split from its unique roster identity';
  END IF;
  INSERT INTO players(id,first_name,last_name,nba_team,nba_id,espn_id) VALUES
    (v_conflict_owner,'FixtureOld','BoxName',NULL,'owned-conflict-nba',NULL),
    (v_conflict_candidate,'FixtureGuard','Target','BOS',NULL,'owned-conflict-espn');
  v_result:=link_player_sources_atomic(p_source=>'nba',p_records=>jsonb_build_array(jsonb_build_object(
    'provider_id','owned-conflict-nba','display_name','FixtureGuard Target','nba_team','BOS','espn_id','different-espn')),p_current_roster=>false);
  IF v_result->'results'->0->>'action'<>'ambiguous' OR NOT EXISTS(SELECT FROM players WHERE id=v_conflict_candidate)
    OR EXISTS(SELECT FROM players WHERE id=v_conflict_owner AND espn_id IS NOT NULL) THEN
    RAISE EXCEPTION 'An incoming conflicting identity merges existing rows before review';
  END IF;
  IF has_function_privilege('authenticated','public.link_player_sources_atomic(text,jsonb,boolean)','EXECUTE') THEN
    RAISE EXCEPTION 'An app client can rewrite source identities';
  END IF;
  PERFORM resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
    'provider_id','connect-espn-aaron','first_name','FixtureAaron','last_name','Holiday','metadata',jsonb_build_object('nba_team','HOU','years_exp',NULL,'position',NULL))));
  IF NOT EXISTS(SELECT FROM players WHERE id=v_a AND years_exp=8 AND position='PG') THEN
    RAISE EXCEPTION 'A sparse roster payload erases known experience or position';
  END IF;
END $$;
ROLLBACK;
SELECT 'source connectivity: 11 checks PASS';
