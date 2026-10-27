BEGIN;
CREATE TEMP TABLE forever_assumption_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_forever_assumption(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO forever_assumption_checks VALUES(label);
END;
$$;

INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES
  (3941,1,DATE '3940-10-12',DATE '3941-04-12'),
  (3942,1,DATE '3941-10-12',DATE '3942-06-12');
UPDATE private.provider_history_policy SET first_season_year=3938,last_season_year=3939 WHERE source='bbref';
UPDATE private.provider_history_policy SET first_season_year=3940 WHERE source='cdn-enum';
SELECT pg_temp.check_forever_assumption((
  SELECT array_agg(source||':'||season_year ORDER BY source DESC,season_year DESC)=ARRAY['cdn-enum:3941','cdn-enum:3940','bbref:3939','bbref:3938']
  FROM public.get_backfill_season_plan(TIMESTAMPTZ '3942-05-01 12:00 UTC')
),'backfill derives completed seasons from the published calendar');
SELECT pg_temp.check_forever_assumption((
  SELECT max(season_year)=3942 FROM public.get_backfill_season_plan(TIMESTAMPTZ '3942-07-01 12:00 UTC')
),'the next completed season joins backfill without a code change');
UPDATE private.provider_history_policy SET first_season_year=3941 WHERE source='cdn-enum';
SELECT pg_temp.check_forever_assumption((
  SELECT count(*)=1 FROM public.get_backfill_season_plan(TIMESTAMPTZ '3942-05-01 12:00 UTC') WHERE source='cdn-enum'
),'provider coverage comes from saved policy');

INSERT INTO public.players(id,first_name,last_name,years_exp)
VALUES(md5('forever-coverage-player')::uuid,'Forever','Coverage',1);
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status) VALUES
  (md5('forever-coverage-before')::uuid,'forever-coverage-before',3940,1,DATE '3940-03-01','BOS','MIN','Final'),
  (md5('forever-coverage-after')::uuid,'forever-coverage-after',3941,1,DATE '3941-03-01','BOS','MIN','Final');
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,minutes_played,did_not_play)
SELECT md5('forever-coverage-player')::uuid,id,season_year,week_number,12,false
FROM public.nba_games WHERE id IN(md5('forever-coverage-before')::uuid,md5('forever-coverage-after')::uuid);
SELECT pg_temp.check_forever_assumption(
  private.player_career_appearances(md5('forever-coverage-player')::uuid,3939)=2,
  'the coverage counter includes eligible recorded games');
UPDATE private.provider_history_policy SET first_season_year=3941,first_game_date=DATE '3941-01-01' WHERE source='career';
SELECT pg_temp.check_forever_assumption(
  private.player_career_appearances(md5('forever-coverage-player')::uuid,3939)=1,
  'moving configured coverage changes the appearance counter');
SELECT pg_temp.check_forever_assumption((
  SELECT base IS NULL FROM private.player_career_fallback(md5('forever-coverage-player')::uuid,1,3941)
),'games before configured coverage cannot certify an incomplete career');
UPDATE private.provider_history_policy SET first_season_year=3940,first_game_date=DATE '3940-01-01' WHERE source='career';
SELECT pg_temp.check_forever_assumption((
  SELECT base=0 AND base_season=3939 AND source='coverage'
  FROM private.player_career_fallback(md5('forever-coverage-player')::uuid,1,3941)
),'configured coverage derives the career base season');
DO $$
DECLARE denied boolean:=false;
BEGIN
  BEGIN
    PERFORM public.complete_player_career_base_atomic(md5('forever-coverage-player')::uuid,'','',NULL,NULL,3939);
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  PERFORM pg_temp.check_forever_assumption(denied,'career base validation follows the configured first season');
END;
$$;
SELECT pg_temp.check_forever_assumption(
  NOT has_function_privilege('anon','public.get_backfill_season_plan(timestamptz)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.get_backfill_season_plan(timestamptz)','EXECUTE')
  AND has_function_privilege('service_role','public.get_backfill_season_plan(timestamptz)','EXECUTE'),
  'only service callers can enumerate historical provider work');
SELECT count(*) AS passed FROM forever_assumption_checks;
ROLLBACK;
