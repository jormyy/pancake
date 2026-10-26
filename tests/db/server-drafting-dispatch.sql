BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE boundary_dispatch_checks (name text);
CREATE OR REPLACE FUNCTION private.roll_setup_league_seasons(p_now timestamptz DEFAULT now())
RETURNS integer LANGUAGE sql AS $$ SELECT 0; $$;
CREATE OR REPLACE FUNCTION private.claim_cron_dispatch(p_job_key text, p_period_key text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true; $$;
CREATE OR REPLACE FUNCTION private.invoke_claimed_edge_function(p_job_key text, p_function_name text, p_body jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO boundary_dispatch_checks VALUES(p_function_name); $$;
DO $$
DECLARE fixture record; league_status public.league_status;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9483,'drafting');
  UPDATE public.leagues SET status='setup' WHERE id<>fixture.league_id AND status IN ('active','playoffs','offseason','drafting');
  FOREACH league_status IN ARRAY ARRAY['drafting','offseason']::public.league_status[] LOOP
    UPDATE public.leagues SET status=league_status WHERE id=fixture.league_id;
    TRUNCATE boundary_dispatch_checks;
    PERFORM public.invoke_season_boundary_if_due(timestamptz '2026-10-24 08:59 America/New_York');
    PERFORM pg_temp.check_rules((SELECT count(*)=0 FROM boundary_dispatch_checks), league_status||' dispatch still waits until nine ET');
    PERFORM public.invoke_season_boundary_if_due(timestamptz '2026-10-24 09:00 America/New_York');
    PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM boundary_dispatch_checks WHERE name='season-boundary'), league_status||' league dispatches the boundary backstop');
  END LOOP;
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
