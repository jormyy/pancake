BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE decimal_fixture(league_id uuid,revision bigint);
DO $$
DECLARE fixture record; player uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); stat uuid:=gen_random_uuid();
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9568,'active');
  UPDATE public.leagues SET scoring_settings='{"points":0.075}' WHERE id=fixture.league_id;
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(fixture.league_id,fixture.season_id,1,fixture.member_ids[1],fixture.member_ids[2]);
  INSERT INTO decimal_fixture SELECT fixture.league_id,revision FROM private.score_input_revisions WHERE scope='league:'||fixture.league_id;
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Decimal','Player');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002-decimal-'||game,9568,1,'9568-01-01','BOS','NYK','Final');
  INSERT INTO public.player_game_stats(id,player_id,game_id,season_year,week_number,game_date,points,did_not_play)
    VALUES(stat,player,game,9568,1,'9568-01-01',3,false);
  PERFORM pg_temp.check_rules(public.compute_fantasy_points(stat,fixture.league_id)=0.23,'SQL uses the same exact decimal score');
END;
$$;
\ir ../../supabase/migrations/20261214008900_refresh_decimal_scoring.sql
DO $$
BEGIN
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.score_input_revisions revision JOIN decimal_fixture fixture
    ON revision.scope='league:'||fixture.league_id WHERE revision.revision>fixture.revision),'custom decimal scores lose old input certificates');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='sync-scores' AND key='decimal-scoring-v2'
    AND status='pending'),'corrected decimal scoring is queued before live publication');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
