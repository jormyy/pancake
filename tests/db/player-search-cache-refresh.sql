-- Compare cached averages with the canonical per-game scoring contract.
-- Synthetic rows, materialized refreshes and permission checks all roll back.
BEGIN;
SET LOCAL statement_timeout = '60s';

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-4000-8000-0000000c0001', 'authenticated', 'authenticated', 'cache-member@example.test', 'x', now(), '{}', '{}', now(), now()),
  ('00000000-0000-4000-8000-0000000c0002', 'authenticated', 'authenticated', 'cache-outsider@example.test', 'x', now(), '{}', '{}', now(), now());

INSERT INTO public.leagues (id, name, slug, commissioner_id, status, scoring_settings)
SELECT ('00000000-0000-4000-8000-' || lpad((120000+n)::text,12,'0'))::uuid,
       'Cache Fixture ' || n, 'cache-fixture-' || n, '00000000-0000-4000-8000-0000000c0001', 'active',
       CASE WHEN n=4 THEN '{}'::jsonb ELSE jsonb_build_object(
         'points', CASE WHEN n=3 THEN 1.337 ELSE 1 END,
         'rebounds', 1.25, 'assists', 1.5, 'steals', 3, 'blocks', 3,
         'turnovers', -1.25, 'three_pointers_made', 0.5,
         'field_goals_made', 0.1, 'field_goals_attempted', -0.2,
         'free_throws_made', 0.3, 'free_throws_attempted', -0.1,
         'double_double', 4.125, 'triple_double', 8.375) END
FROM generate_series(1,4)n;
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
SELECT ('00000000-0000-4000-8000-' || lpad((121000+n)::text,12,'0'))::uuid,
       ('00000000-0000-4000-8000-' || lpad((120000+n)::text,12,'0'))::uuid,
       '00000000-0000-4000-8000-0000000c0001', 'commissioner', 'Fixture Team'
FROM generate_series(1,4)n;
INSERT INTO public.players (id, first_name, last_name, position, eligible_positions, status, nba_team)
VALUES ('00000000-0000-4000-8000-0000000c0401', 'Cache', 'Player', 'PG', ARRAY['PG'], 'Active', 'BOS');
INSERT INTO public.nba_games (id, season_year, game_date, week_number, home_team, away_team, status, nba_game_id)
SELECT ('00000000-0000-4000-8000-' || lpad((122000+n)::text,12,'0'))::uuid,public.current_season_year_et(),current_date-n,1,'BOS','LAL','Final',
       CASE WHEN n=5 THEN '003cache-test' ELSE '002cache-test-'||n END
FROM generate_series(1,5)n;
INSERT INTO public.player_game_stats (player_id, game_id, season_year, week_number, points, rebounds, assists, steals, blocks, turnovers, three_pointers_made, field_goals_made, field_goals_attempted, free_throws_made, free_throws_attempted, double_double, triple_double, did_not_play)
SELECT '00000000-0000-4000-8000-0000000c0401',
       ('00000000-0000-4000-8000-' || lpad((122000+n)::text,12,'0'))::uuid,
       public.current_season_year_et(),1,CASE WHEN n=2 THEN NULL ELSE n*7 END,n*3,n,1,2,n,3,4,11,2,3,n=1,n=3,n=4
FROM generate_series(1,5)n;

CREATE TEMP TABLE expected_cache AS
SELECT fp.league_id,fp.player_id,fp.season_year,ROUND(AVG(fp.fantasy_points)::numeric,2) AS avg_fantasy_points
FROM public.v_fantasy_points fp JOIN public.player_game_stats s ON s.id=fp.stat_id AND NOT s.did_not_play
GROUP BY fp.league_id,fp.player_id,fp.season_year;
CREATE FUNCTION pg_temp.assert_cache_equal() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS ((TABLE expected_cache EXCEPT ALL TABLE analytics.mv_player_avg_fantasy_points)
    UNION ALL (TABLE analytics.mv_player_avg_fantasy_points EXCEPT ALL TABLE expected_cache)) THEN
    RAISE EXCEPTION 'Cached fantasy averages differ from per-game scoring';
  END IF;
END $$;

UPDATE analytics.search_cache_refresh_state SET refreshed_at=now()-interval '8 days';
SELECT public.refresh_player_search_caches();
SELECT pg_temp.assert_cache_equal();
DO $$ BEGIN
  -- Existing leagues also receive this player's scores; count only our four fixtures.
  IF (SELECT count(*) FROM analytics.mv_player_avg_fantasy_points
      WHERE player_id='00000000-0000-4000-8000-0000000c0401'
        AND league_id IN (
          SELECT ('00000000-0000-4000-8000-' || lpad((120000+n)::text,12,'0'))::uuid
          FROM generate_series(1,4)n
        )) <> 4 THEN
    RAISE EXCEPTION 'Expected one cached result for each fixture league';
  END IF;
END $$;

-- Demonstrate that the equivalence oracle rejects a changed score.
SAVEPOINT before_corruption;
UPDATE expected_cache SET avg_fantasy_points=avg_fantasy_points+0.01 WHERE player_id='00000000-0000-4000-8000-0000000c0401';
DO $$ BEGIN
  BEGIN
    PERFORM pg_temp.assert_cache_equal();
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='Cached fantasy averages differ from per-game scoring' THEN RETURN; END IF;
    RAISE;
  END;
  RAISE EXCEPTION 'The cache equivalence oracle accepted altered scores';
END $$;
ROLLBACK TO SAVEPOINT before_corruption;

SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0001',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM public.v_player_avg_fantasy_points WHERE player_id='00000000-0000-4000-8000-0000000c0401') <> 4 THEN
    RAISE EXCEPTION 'Member cannot read own cached scores';
  END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000c0002',true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.v_player_avg_fantasy_points WHERE player_id='00000000-0000-4000-8000-0000000c0401') THEN
    RAISE EXCEPTION 'Outsider can read another league cache through the public view';
  END IF;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','',true);
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM 1 FROM public.v_player_avg_fantasy_points;
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Anonymous cache access must retain its permission denial';
END $$;
RESET ROLE;

-- A new league uses the side cache before the next materialized refresh.
INSERT INTO public.leagues (id,name,slug,commissioner_id,status,scoring_settings)
SELECT '00000000-0000-4000-8000-0000000c0999','Cache Fresh League','cache-fresh-league',commissioner_id,'active',scoring_settings
FROM public.leagues WHERE id='00000000-0000-4000-8000-000000120001';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM analytics.player_avg_fantasy_points_fresh WHERE league_id='00000000-0000-4000-8000-0000000c0999') THEN
    RAISE EXCEPTION 'New league has no immediate side cache';
  END IF;
END $$;
CREATE TEMP TABLE expected_fresh AS
SELECT player_id,season_year,avg_fantasy_points FROM analytics.player_avg_fantasy_points_fresh
WHERE league_id='00000000-0000-4000-8000-0000000c0999';
UPDATE analytics.search_cache_refresh_state SET refreshed_at=now()-interval '8 days';
SELECT public.refresh_player_search_caches();
DO $$ BEGIN
  IF EXISTS ((TABLE expected_fresh EXCEPT ALL SELECT player_id,season_year,avg_fantasy_points FROM analytics.mv_player_avg_fantasy_points WHERE league_id='00000000-0000-4000-8000-0000000c0999')
    UNION ALL (SELECT player_id,season_year,avg_fantasy_points FROM analytics.mv_player_avg_fantasy_points WHERE league_id='00000000-0000-4000-8000-0000000c0999' EXCEPT ALL TABLE expected_fresh)) THEN
    RAISE EXCEPTION 'Full refresh changes the fresh league scores';
  END IF;
  IF EXISTS (SELECT 1 FROM analytics.player_avg_fantasy_points_fresh WHERE league_id='00000000-0000-4000-8000-0000000c0999') THEN
    RAISE EXCEPTION 'Full refresh leaves redundant fresh rows';
  END IF;
END $$;
ROLLBACK;
