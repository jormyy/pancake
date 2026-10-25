BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; players uuid[]:=ARRAY[gen_random_uuid(),gen_random_uuid()]; offer uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9549);
  UPDATE leagues SET allow_inactive_trades=true,taxi_slots=1 WHERE id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp)
    VALUES(players[1],'Unknown','Games','PG',ARRAY['PG'],1),(players[2],'Healthy','Veteran','PG',ARRAY['PG'],4);
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],players[1],'draft'),(f.league_id,f.season_id,f.member_ids[2],players[2],'draft');
  offer:=public.propose_trade_atomic(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2],ARRAY[players[1]],ARRAY[players[2]],'{}','{}');
  PERFORM pg_temp.reject_rules(format('SELECT public.accept_trade_with_plan_atomic(%L,%L,%L,ARRAY[%L]::uuid[],''{}'',''{}'')',offer,f.member_ids[2],f.user_ids[2],players[1]),'The career games count is not known yet. This player cannot enter taxi.','unknown taxi trade explains its missing games count');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
