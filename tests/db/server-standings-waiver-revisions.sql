BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; before_revision bigint; before_rows jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9527);
  INSERT INTO matchups(league_id,league_season_id,week_number,matchup_type,home_member_id,away_member_id,
    home_points,away_points,winner_member_id,is_finalized)
    VALUES(f.league_id,f.season_id,1,'regular_season',f.member_ids[1],f.member_ids[2],10,5,f.member_ids[1],true);
  PERFORM private.rebuild_regular_standings(f.league_id,f.season_id);
  SELECT revision INTO before_revision FROM private.score_input_revisions WHERE scope='result:'||f.season_id||':1';
  SELECT jsonb_agg(to_jsonb(s) ORDER BY member_id) INTO before_rows FROM standings s WHERE league_season_id=f.season_id;
  UPDATE waiver_priorities SET priority=priority+10 WHERE league_season_id=f.season_id;
  PERFORM private.rebuild_regular_standings(f.league_id,f.season_id);
  PERFORM pg_temp.check_rules((SELECT revision=before_revision FROM private.score_input_revisions WHERE scope='result:'||f.season_id||':1'),
    'waiver changes do not invalidate completed scoring');
  PERFORM pg_temp.check_rules(before_rows=(SELECT jsonb_agg(to_jsonb(s) ORDER BY member_id) FROM standings s WHERE league_season_id=f.season_id),
    'rebuild leaves historical rows unchanged after waiver reorder');
  UPDATE standings SET waiver_priority=99 WHERE league_season_id=f.season_id;
  PERFORM pg_temp.check_rules((SELECT revision=before_revision FROM private.score_input_revisions WHERE scope='result:'||f.season_id||':1'),
    'deployed Edge can still write the legacy field without invalidating scores');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
