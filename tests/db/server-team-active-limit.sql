BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; problem record; code text;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9552);
  UPDATE leagues SET roster_size=2 WHERE id=f.league_id;
  WITH players AS (INSERT INTO public.players(first_name,last_name,position,eligible_positions,years_exp)
    SELECT 'Active',n::text,'PG',ARRAY['PG'],3 FROM generate_series(1,3) n RETURNING id)
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    SELECT f.league_id,f.season_id,f.member_ids[1],id,'trade' FROM players;
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1]) WHERE kind='active_limit'),'active excess emits one team problem');
  SELECT * INTO problem FROM private.roster_problems(f.league_id,f.season_id,f.member_ids[1]) WHERE kind='active_limit';
  PERFORM pg_temp.check_rules(problem.roster_player_id IS NULL AND problem.player_name IS NULL AND problem.message='Your active roster is 1 over the limit of 2. Drop or move an eligible player to IR.','active problem has no player identity and gives the excess and limit');
  BEGIN PERFORM private.assert_legal_roster(f.league_id,f.season_id,f.member_ids[1]); EXCEPTION WHEN OTHERS THEN code:=SQLSTATE; END;
  PERFORM pg_temp.check_rules(code='PA003','active excess uses PA003');
  PERFORM pg_temp.reject_rules(format('SELECT private.assert_roster_within_active_limit(%L,%L,%L)',f.league_id,f.season_id,f.member_ids[1]),'Roster is over the active player limit.%','one team problem still blocks the active-limit assertion');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
