BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; g record; v_before timestamptz;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9802);
  SELECT * INTO g FROM pg_temp.rules_fixture(2, 9803);
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, 16, true);
  IF private.league_auto_ir_all_members(f.league_id) THEN
    RAISE EXCEPTION 'the policy is active without an explicit activation';
  END IF;
  PERFORM pg_temp.check_rules(
    (SELECT floor_activated_at IS NULL AND ir_activated_at IS NULL
       FROM private.league_roster_policies WHERE league_id = f.league_id),
    'a fresh policy row leaves both activation latches NULL');
  PERFORM pg_temp.check_rules(
    private.run_league_roster_floor(f.league_id, f.season_id)->>'reason' = 'worker_pending',
    'the floor defers before activation');
  PERFORM pg_temp.check_rules(
    NOT private.activate_league_roster_policy(g.league_id),
    'activation refuses a league without a policy row');
  PERFORM pg_temp.check_rules(
    private.activate_league_roster_policy(f.league_id),
    'activation accepts a league with a policy row');
  PERFORM pg_temp.check_rules(
    (SELECT floor_activated_at IS NOT NULL AND ir_activated_at IS NOT NULL
       FROM private.league_roster_policies WHERE league_id = f.league_id),
    'activation sets both latches');
  PERFORM pg_temp.check_rules(
    private.league_auto_ir_all_members(f.league_id),
    'activation enables league-wide IR');
  PERFORM pg_temp.check_rules(
    NOT private.league_auto_ir_all_members(g.league_id),
    'activation does not reach another league');
  SELECT ir_activated_at INTO v_before FROM private.league_roster_policies WHERE league_id = f.league_id;
  PERFORM private.activate_league_roster_policy(f.league_id);
  PERFORM pg_temp.check_rules(
    (SELECT ir_activated_at FROM private.league_roster_policies WHERE league_id = f.league_id) = v_before,
    'activation is idempotent');
  UPDATE private.league_roster_policies SET floor_activated_at = NULL, ir_activated_at = NULL
   WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(
    NOT private.league_auto_ir_all_members(f.league_id),
    'the documented rollback returns the league to base behavior');
  IF EXISTS (SELECT 1 FROM private.retention_rules
              WHERE relation_name IN ('private.draft_pick_calendar_repairs', 'private.public_api_buckets')) THEN
    RAISE EXCEPTION 'legacy retention rows remain';
  END IF;
END;
$$;
ROLLBACK;
