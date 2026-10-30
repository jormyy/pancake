\set ON_ERROR_STOP on
\getenv version_db_port PANCAKE_TEST_DB_PORT
\if :{?version_db_port}
\else
  \set version_db_port 59122
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'version_db_port' AS version_local \gset
\if :version_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private loopback version test database.'; END $$;
\endif
SET statement_timeout='60s';
SET lock_timeout='5s';
SET app.supabase_url='http://127.0.0.1:64591';
SET app.edge_internal_token='local-version-probe';
BEGIN;
DELETE FROM public.draft_orders WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.draft_budgets WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.snake_draft_picks WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.bids WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.nominations WHERE draft_id IN (SELECT draft.id FROM public.drafts draft JOIN public.league_seasons season ON season.league_id=draft.league_id WHERE season.season_year=9562);
DELETE FROM public.drafts WHERE league_id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.leagues WHERE id IN (SELECT league_id FROM public.league_seasons WHERE season_year=9562);
DELETE FROM public.player_game_stats WHERE season_year=9562;
DELETE FROM public.player_projections WHERE season_year=9562;
DELETE FROM public.players WHERE first_name='Version';
DELETE FROM public.nba_games WHERE season_year=9562;
DELETE FROM public.season_weeks WHERE season_year=9562;
\ir rules-support.sql
CREATE TEMP TABLE version_fixture AS SELECT * FROM pg_temp.rules_fixture(3,9562);
ALTER TABLE version_fixture ADD COLUMN players uuid[];
ALTER TABLE version_fixture ADD COLUMN matchup_id uuid DEFAULT gen_random_uuid();
ALTER TABLE version_fixture ADD COLUMN game_id uuid DEFAULT gen_random_uuid();
ALTER TABLE version_fixture ADD COLUMN draft_id uuid;
ALTER TABLE version_fixture ADD COLUMN trade_id uuid;
ALTER TABLE version_fixture ADD COLUMN claim_id uuid;
DO $$
DECLARE f record; ids uuid[];
BEGIN
  INSERT INTO public.players(first_name,last_name,position,eligible_positions,status,nba_team,injury_status,years_exp,nba_draft_number)
    SELECT 'Version',gen_random_uuid()::text,'PG',ARRAY['PG'],'Active','BOS','Out',0,n FROM generate_series(1,12)n;
  SELECT array_agg(id ORDER BY nba_draft_number) INTO ids FROM public.players WHERE first_name='Version';
  UPDATE version_fixture SET players=ids;
  SELECT * INTO f FROM version_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,false);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9562,1,current_date,current_date+6);
  INSERT INTO public.nba_games(id,season_year,nba_game_id,game_date,week_number,home_team,away_team,status,game_time)
    VALUES(f.game_id,9562,'0029562001',current_date,1,'BOS','NYK','Scheduled',now()+interval '8 hours');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(f.matchup_id,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.lineup_slot_templates(league_id,slot_type,slot_count) VALUES(f.league_id,'PG',4) ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=4;
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[2],f.players[2],'draft'),(f.league_id,f.season_id,f.member_ids[1],f.players[1],'draft');
END;
$$;
COMMIT;
CREATE TEMP TABLE version_proofs(label text PRIMARY KEY,before_version bigint,after_version bigint);
CREATE PROCEDURE pg_temp.version_write(label text,command text,expected integer DEFAULT 1,rejection text DEFAULT NULL)
LANGUAGE plpgsql AS $$
DECLARE league uuid; before_version bigint; after_version bigint; caught text; publication record;
BEGIN
  SELECT league_id INTO league FROM version_fixture;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=league;
  BEGIN
    EXECUTE command;
  EXCEPTION WHEN OTHERS THEN
    IF rejection IS NULL OR SQLERRM NOT LIKE rejection THEN RAISE; END IF;
    caught:=SQLERRM;
  END;
  IF rejection IS NOT NULL AND caught IS NULL THEN RAISE EXCEPTION 'Expected rejection: %',label; END IF;
  COMMIT;
  FOR publication IN SELECT id FROM private.trade_publications WHERE league_id=league ORDER BY id LOOP
    PERFORM private.publish_trade_changes(publication.id);
    DELETE FROM private.work_items WHERE kind='trade-publication' AND payload->>'publicationId'=publication.id::text;
  END LOOP;
  COMMIT;
  SELECT version INTO after_version FROM public.league_versions WHERE league_id=league;
  IF after_version IS DISTINCT FROM before_version+expected THEN
    RAISE EXCEPTION '%: expected bump %, before %, after %',label,expected,before_version,after_version;
  END IF;
  IF (SELECT count(*) FROM public.league_changes WHERE league_id=league AND version>before_version)<>expected THEN
    RAISE EXCEPTION '%: change log does not match bump',label;
  END IF;
  IF (SELECT revision FROM public.league_change_hints WHERE league_id=league AND topic='version')<>after_version THEN
    RAISE EXCEPTION '%: realtime does not match version',label;
  END IF;
  IF EXISTS(SELECT 1 FROM private.league_version_pending) THEN RAISE EXCEPTION 'Commit leaves pending work'; END IF;
  INSERT INTO version_proofs VALUES(label,before_version,after_version);
END;
$$;
\ir league-version-draft-writes.sql
SELECT count(*) AS draft_version_checks FROM version_proofs;
BEGIN;
DELETE FROM public.draft_orders WHERE draft_id IN(SELECT id FROM public.drafts WHERE league_id=(SELECT league_id FROM version_fixture));
DELETE FROM public.draft_budgets WHERE draft_id IN(SELECT id FROM public.drafts WHERE league_id=(SELECT league_id FROM version_fixture));
DELETE FROM public.snake_draft_picks WHERE draft_id IN(SELECT id FROM public.drafts WHERE league_id=(SELECT league_id FROM version_fixture));
DELETE FROM public.drafts WHERE league_id=(SELECT league_id FROM version_fixture);
DELETE FROM public.leagues WHERE id=(SELECT league_id FROM version_fixture);
DELETE FROM public.players WHERE first_name='Version';
DELETE FROM public.nba_games WHERE season_year=9562;
DELETE FROM public.season_weeks WHERE season_year=9562;
DELETE FROM auth.users WHERE id=ANY((SELECT user_ids FROM version_fixture)::uuid[]);
COMMIT;
