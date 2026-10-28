\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid := gen_random_uuid(); body jsonb; old_body jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, public.current_season_year_et());
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,injury_status,injury_reason)
    VALUES(player,'Profile','Fixture','PG',ARRAY['PG'],'BOS','Out','Ankle');
  INSERT INTO public.player_season_averages(league_id,league_season_id,player_id,season_year,averages,avg_fantasy_points,version)
    VALUES(f.league_id,f.season_id,player,public.current_season_year_et(),'{"games_played":80,"avg_points":24}',35,1);
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'section','overview'));
  PERFORM pg_temp.check_rules(body->'player'->>'injury_reason' = 'Ankle' AND (body->'averages'->>'gamesPlayed')::int = 80 AND body->>'avgFantasyPoints' = '35', 'overview includes injury and full-season averages');
  PERFORM pg_temp.check_rules(body ? 'nextProjection' AND body ? 'pickup' AND NOT (body ?| ARRAY['lines','gameLog','transactions','roster','news']), 'overview includes actions without lazy rows');
  body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'section','games'));
  PERFORM pg_temp.check_rules(body ? 'lines' AND body ? 'hasMoreGames' AND NOT body ? 'player', 'game log has its own payload');
  body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'section','news'));
  PERFORM pg_temp.check_rules(body->'news' = '[]'::jsonb AND NOT body ? 'lines', 'news loads separately');
  body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'section','history'));
  PERFORM pg_temp.check_rules(body->'transactions' = '[]'::jsonb AND NOT body ? 'lines', 'history loads separately');
  EXECUTE 'SET LOCAL ROLE authenticated';
  body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'section','overview'));
  PERFORM pg_temp.check_rules(body->'player'->>'id' = player::text, 'authenticated member can load the compact view');
  EXECUTE 'RESET ROLE';
  old_body := public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player));
  PERFORM pg_temp.check_rules(old_body ? 'roster' AND old_body ? 'lines', 'legacy player payload remains supported');
END $$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
