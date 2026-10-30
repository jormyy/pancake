\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='120s';
\ir rules-support.sql
CREATE FUNCTION pg_temp.pipeline_old_context(p_matchup_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT CASE WHEN private.matchup_forecast_inputs_ready(p_matchup_id)
    THEN private.read_matchup_forecast_context(p_matchup_id)
    ELSE private.compute_matchup_forecast_context(p_matchup_id) END || jsonb_build_object('seasonAverages',COALESCE((
    SELECT jsonb_agg(jsonb_build_object('player_id',a.player_id,'avg_fantasy_points',a.avg_fantasy_points) ORDER BY a.player_id)
    FROM public.matchups m
    JOIN public.league_seasons s ON s.id=m.league_season_id
    JOIN public.v_player_avg_fantasy_points a ON a.league_id=m.league_id AND a.season_year=s.season_year
    WHERE m.id=p_matchup_id AND EXISTS (
      SELECT 1 FROM public.roster_players r WHERE r.league_season_id=m.league_season_id
        AND r.member_id IN(m.home_member_id,m.away_member_id) AND r.player_id=a.player_id
    )
  ),'[]'::jsonb));
$$;
CREATE TEMP TABLE pipeline_matchups AS
SELECT m.id,m.league_id,m.league_season_id FROM public.matchups m
JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
WHERE NOT m.is_voided AND m.week_number IN(2,3,4)
ORDER BY m.week_number,m.id LIMIT 15;
DO $$
DECLARE m record; original jsonb; prepared jsonb;
BEGIN
  PERFORM pg_temp.check_rules((SELECT count(*)=15 FROM pipeline_matchups),'fifteen restored matchups cover three weeks');
  DELETE FROM private.forecast_player_history;
  DELETE FROM private.forecast_projection_inputs;
  FOR m IN SELECT * FROM pipeline_matchups LOOP
    original:=pg_temp.pipeline_old_context(m.id);
    PERFORM pg_temp.check_rules(public.get_matchup_forecast_context(m.id)=original,'unprepared '||m.id);
    PERFORM public.prepare_matchup_forecast_inputs(m.id);
    prepared:=pg_temp.pipeline_old_context(m.id);
    PERFORM pg_temp.check_rules(public.get_matchup_forecast_context(m.id)=prepared,'prepared '||m.id);
    PERFORM pg_temp.check_rules(public.get_prepared_matchup_forecast_context(m.id)=prepared,'worker '||m.id);
  END LOOP;
  PERFORM pg_temp.check_rules(public.get_matchup_forecast_context(NULL) IS NULL,'null matchup');
  PERFORM pg_temp.check_rules(public.get_matchup_forecast_context('fabe1700-ffff-4000-8000-ffffffffffff') IS NULL,'missing matchup');
END $$;
SAVEPOINT empty_rosters;
DO $$ DECLARE f record; matchup uuid:=gen_random_uuid(); BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9598);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9598,1,current_date,current_date+6);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  PERFORM pg_temp.check_rules(public.get_matchup_forecast_context(matchup)=pg_temp.pipeline_old_context(matchup),'empty roster and season averages');
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK TO empty_rosters;
SAVEPOINT void_matchups;
UPDATE public.matchups SET is_voided=true WHERE id IN(SELECT id FROM pipeline_matchups);
DO $$ DECLARE m record; BEGIN
  FOR m IN SELECT * FROM pipeline_matchups LOOP
    PERFORM pg_temp.check_rules(public.get_matchup_forecast_context(m.id) IS NOT DISTINCT FROM pg_temp.pipeline_old_context(m.id),'void matchup '||m.id);
  END LOOP;
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK TO void_matchups;
SET LOCAL ROLE service_role;
SELECT public.get_matchup_forecast_context('68b5fbc2-7c67-476f-a408-c4a73ac21681') IS NOT NULL AS service_role_context;
RESET ROLE;
ROLLBACK;
