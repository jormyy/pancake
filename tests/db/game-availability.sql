BEGIN;
\ir rules-support.sql
DELETE FROM private.work_items WHERE kind='player-injuries';
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2098,1,'2098-01-05','2098-01-11')
  ON CONFLICT DO NOTHING;
CREATE TEMP TABLE availability_games(id uuid PRIMARY KEY, label text);
INSERT INTO availability_games VALUES(gen_random_uuid(),'postponed'),(gen_random_uuid(),'played');
INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_status_text,game_time)
SELECT id,CASE label WHEN 'postponed' THEN '0029800001' ELSE '0029800002' END,2098,1,
  CASE label WHEN 'postponed' THEN date '2098-01-07' ELSE date '2098-01-08' END,
  CASE label WHEN 'postponed' THEN 'PPA' ELSE 'PLA' END,CASE label WHEN 'postponed' THEN 'PPB' ELSE 'PLB' END,
  'Scheduled',CASE label WHEN 'postponed' THEN 'PPD - postponed' END,
  CASE label WHEN 'postponed' THEN timestamptz '2098-01-07 19:00 America/Los_Angeles' ELSE timestamptz '2098-01-08 19:00 America/Los_Angeles' END
FROM availability_games;
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); context jsonb;
  postponed uuid:=(SELECT id FROM availability_games WHERE label='postponed');
BEGIN
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work(timestamptz '2098-01-07 18:30 America/Los_Angeles')),
    'a postponed game schedules no pregame projection sync');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.projection_sync_due_work(timestamptz '2098-01-08 18:30 America/Los_Angeles') WHERE period_key='2098-01-08:pregame'),
    'a playable game schedules its pregame projection sync');

  PERFORM private.enqueue_player_injuries(timestamptz '2098-01-07 21:00 America/New_York');
  PERFORM pg_temp.check_rules((SELECT array_agg(key) FROM private.work_items WHERE kind='player-injuries')=ARRAY['2098-01-07'],
    'a postponed game leaves injuries on the off-day cadence');
  DELETE FROM private.work_items WHERE kind='player-injuries';
  PERFORM private.enqueue_player_injuries(timestamptz '2098-01-08 21:00 America/New_York');
  PERFORM pg_temp.check_rules((SELECT array_agg(key) FROM private.work_items WHERE kind='player-injuries')=ARRAY[date_bin(interval '15 minutes',timestamptz '2098-01-08 21:00 America/New_York',timestamptz '2000-01-01 00:00 UTC')::text],
    'a playable game moves injuries to the quarter-hour cadence');

  SELECT * INTO f FROM pg_temp.rules_fixture(2,2098);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  context:=private.compute_matchup_forecast_context(matchup);
  PERFORM pg_temp.check_rules(jsonb_array_length(context->'games')=1 AND NOT (context->'games') @> jsonb_build_array(jsonb_build_object('id',postponed)),
    'the forecast leaves out a postponed game');
  PERFORM pg_temp.check_rules(private.lineup_game_available('Scheduled','PPD - postponed') IS FALSE
    AND private.lineup_game_available('InProgress','Suspended') IS FALSE
    AND private.lineup_game_available('Scheduled','Cancelled: absent from complete schedule') IS FALSE
    AND private.lineup_game_available('Final','Final/OT') IS TRUE,
    'the SQL rule matches core gameAvailable');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
