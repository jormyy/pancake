BEGIN;
SET LOCAL statement_timeout='60s';
CREATE OR REPLACE FUNCTION pg_temp.pipeline_poll_reference(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  id uuid, nba_game_id text, game_date date, season_year int, week_number int, status text,
  game_time timestamptz, started_at timestamptz, home_team text, away_team text,
  home_score int, away_score int, game_status_text text, stats_synced_at timestamptz,
  needs_scoreboard boolean, needs_stats boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH candidates AS (
    SELECT game.*,
      game.status = 'InProgress' OR (
        game.status = 'Scheduled'
        AND (
          COALESCE(game.game_time,game.started_at) BETWEEN p_now-interval '45 minutes' AND p_now+interval '2 minutes'
          OR (
            (COALESCE(game.game_time,game.started_at) < p_now-interval '45 minutes'
              OR (COALESCE(game.game_time,game.started_at) IS NULL AND
                ((p_now AT TIME ZONE 'America/New_York')::time >= time '11:00' OR game.game_date < (p_now AT TIME ZONE 'America/New_York')::date)))
            AND (attempt.checked_at IS NULL OR attempt.checked_at <= p_now-interval '30 minutes')
          )
        )
      ) AS board_due,
      game.status = 'InProgress' OR (game.status = 'Final'
        AND (game.stats_synced_at IS NULL OR game.stats_synced_at <= p_now-interval '30 minutes')
        AND (attempt.stats_attempted_at IS NULL OR attempt.stats_attempted_at <= p_now-interval '30 minutes')) AS stats_due
    FROM public.nba_games game
    LEFT JOIN private.live_poll_game_state attempt ON attempt.game_id=game.id
    WHERE game.game_date IN ((p_now AT TIME ZONE 'America/New_York')::date-1,(p_now AT TIME ZONE 'America/New_York')::date)
      AND game.nba_game_id LIKE '002%'
      AND private.lineup_game_available(game.status,game.game_status_text)
  )
  SELECT game.id,game.nba_game_id,game.game_date,game.season_year,game.week_number,game.status,
    game.game_time,game.started_at,game.home_team,game.away_team,game.home_score,game.away_score,
    game.game_status_text,game.stats_synced_at,game.board_due,game.stats_due
  FROM candidates game
  WHERE game.board_due OR game.stats_due
  ORDER BY game.game_date,game.id;
$$;

DO $$
DECLARE ref timestamptz; expected jsonb; actual jsonb; iteration integer:=0;
BEGIN
  FOREACH ref IN ARRAY ARRAY['2026-01-15 10:59:00 America/New_York'::timestamptz,
    '2026-07-15 11:00:00 America/New_York'::timestamptz] LOOP
    INSERT INTO public.nba_games(nba_game_id,game_date,season_year,week_number,home_team,away_team,status,game_time,stats_synced_at,game_status_text)
    SELECT '002997'||iteration||lpad(n::text,6,'0'),(ref AT TIME ZONE 'America/New_York')::date+(n%5-2),9998,1,'BOS','MIA',
      (ARRAY['Scheduled','InProgress','Final','Postponed'])[1+n%4],
      CASE WHEN n%7=0 THEN NULL ELSE ref+(ARRAY[interval '-46 minutes',interval '-45 minutes',interval '2 minutes',interval '2 minutes 0.001 seconds',interval '3 hours',interval '-1 minute'])[1+n%6] END,
      CASE WHEN n%3=0 THEN NULL WHEN n%3=1 THEN ref ELSE ref-interval '30 minutes' END,
      CASE WHEN n%11=0 THEN 'PPD' ELSE '' END
    FROM generate_series(1,2048) n;
    INSERT INTO private.live_poll_game_state(game_id,checked_at,stats_attempted_at)
    SELECT id,CASE WHEN right(nba_game_id,1)::int%2=0 THEN ref ELSE ref-interval '30 minutes' END,
      CASE WHEN right(nba_game_id,1)::int%2=0 THEN ref ELSE ref-interval '30 minutes' END
    FROM public.nba_games WHERE season_year=9998 AND right(nba_game_id,1)::int%3<>0;
    SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.game_date,w.id),'[]') INTO expected FROM pg_temp.pipeline_poll_reference(ref) w;
    SELECT coalesce(jsonb_agg(to_jsonb(w) ORDER BY w.game_date,w.id),'[]') INTO actual FROM public.get_live_poll_work(ref) w;
    IF expected IS DISTINCT FROM actual THEN RAISE EXCEPTION 'Full poll result parity failed at %',ref; END IF;
    IF jsonb_array_length(expected)=0 THEN RAISE EXCEPTION 'Parity fixture has no work'; END IF;
    IF expected=expected-0 THEN RAISE EXCEPTION 'Dropped-result control did not fail'; END IF;
    DELETE FROM public.nba_games WHERE season_year=9998;
    iteration:=iteration+1;
  END LOOP;
END;
$$;
ROLLBACK;
