\set ON_ERROR_STOP on
BEGIN;
WITH fixture AS (SELECT id FROM public.players WHERE sportsdata_id='e2e-player-001'), games AS (
  INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status,game_time)
  SELECT '002ui7profile'||lpad(n::text,3,'0'),public.current_season_year_et(), (now() AT TIME ZONE 'America/New_York')::date - (n % 20),1,'ATL','BOS','Final',now()-interval '1 day'
  FROM generate_series(1,80) n ON CONFLICT(nba_game_id) DO UPDATE SET status='Final' RETURNING id,game_date
)
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,rebounds,assists,minutes_played,did_not_play)
SELECT fixture.id,games.id,public.current_season_year_et(),1,24,6,8,32,false FROM fixture CROSS JOIN games ON CONFLICT(player_id,game_id) DO NOTHING;
INSERT INTO public.nba_games(nba_game_id,season_year,game_date,week_number,home_team,away_team,status,game_time)
VALUES('002ui7profilenext',public.current_season_year_et(),(now() AT TIME ZONE 'America/New_York')::date + 1,1,'ATL','BOS','Scheduled',now()+interval '1 day')
ON CONFLICT(nba_game_id) DO UPDATE SET game_time=excluded.game_time,game_date=excluded.game_date;
UPDATE public.players SET injury_status='Out',injury_reason='Ankle',injury_expected_return='Day to day',dynasty_rank=1 WHERE sportsdata_id='e2e-player-001';
INSERT INTO public.dynasty_news(player_id,title,summary,source,url,published_at)
SELECT id,'Profile fixture update','A synthetic local player update for the profile check.','Local fixture','https://example.test/local-profile',now() FROM public.players WHERE sportsdata_id='e2e-player-001' ON CONFLICT DO NOTHING;
SELECT public.refresh_player_search_caches();
COMMIT;
