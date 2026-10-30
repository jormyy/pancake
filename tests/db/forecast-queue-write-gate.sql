BEGIN;
\ir rules-support.sql
\ir scheduler-chunk-support.sql
CREATE TEMP TABLE forecast_gate_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9592);
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
VALUES(9592,1,current_date,current_date+6);
CREATE TEMP TABLE forecast_gate_matchup AS
WITH added AS (
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
  SELECT league_id,season_id,1,member_ids[1],member_ids[2] FROM forecast_gate_fixture RETURNING id,league_id
) SELECT id,league_id FROM added;
SELECT pg_temp.drain_forecast_chunks();
CREATE TEMP TABLE forecast_gate_count(writes integer);
INSERT INTO forecast_gate_count VALUES(0);
CREATE FUNCTION pg_temp.count_forecast_gate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE pg_temp.forecast_gate_count SET writes=writes+1;
  RETURN NULL;
END;
$$;
CREATE TRIGGER count_forecast_gate AFTER UPDATE ON private.matchup_forecast_queue
FOR EACH ROW EXECUTE FUNCTION pg_temp.count_forecast_gate();
DO $$
DECLARE f record; initial_revision bigint; token uuid:=gen_random_uuid();
BEGIN
  SELECT id,league_id INTO f FROM forecast_gate_matchup;
  SELECT revision INTO initial_revision FROM private.matchup_forecast_queue WHERE matchup_id=f.id;
  FOR attempt IN 1..100 LOOP PERFORM private.queue_matchup_forecasts(f.league_id,f.id); END LOOP;
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT writes=0 FROM forecast_gate_count),'identical invalidations write no queue rows');
  UPDATE private.matchup_forecast_queue SET dirty=false,computed_fingerprint=input_fingerprint,
    available_at=now()+interval '1 hour' WHERE matchup_id=f.id;
  UPDATE forecast_gate_count SET writes=0;
  PERFORM private.queue_matchup_forecasts(f.league_id,f.id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT writes=0 FROM forecast_gate_count),'unchanged completed inputs stay clean');
  PERFORM pg_temp.check_rules((SELECT NOT dirty AND available_at=now()+interval '1 hour' AND revision=initial_revision FROM private.matchup_forecast_queue WHERE matchup_id=f.id),'unchanged inputs preserve availability and revision');
  UPDATE private.matchup_forecast_queue SET changed_at=transaction_timestamp()-interval '1 second',claim_token=token,claimed_at=now(),claimed_revision=initial_revision WHERE matchup_id=f.id;
  UPDATE forecast_gate_count SET writes=0;
  UPDATE public.matchups SET home_points=1 WHERE id=f.id;
  PERFORM private.queue_matchup_forecasts(f.league_id,f.id);
  PERFORM private.queue_matchup_forecasts(f.league_id,f.id);
  PERFORM pg_temp.drain_forecast_chunks();
  PERFORM pg_temp.check_rules((SELECT writes=1 FROM forecast_gate_count),'one changed input produces one write');
  PERFORM pg_temp.check_rules((SELECT dirty AND revision=initial_revision+1 AND claim_token=token AND claimed_revision=initial_revision FROM private.matchup_forecast_queue WHERE matchup_id=f.id),'changed inputs preserve the stale lease for completion rejection');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
