BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='home-version-scope';
\ir rules-support.sql
DO $$
DECLARE f record; change jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9569);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS ALL DEFERRED;
  CREATE TEMP TABLE standings_current(id uuid,league_id uuid,league_season_id uuid,member_id uuid,wins integer,losses integer,points_for numeric);
  CREATE TRIGGER home_version_scope AFTER UPDATE ON pg_temp.standings_current
    REFERENCING NEW TABLE AS version_new_rows OLD TABLE AS version_old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
  INSERT INTO pg_temp.standings_current VALUES(gen_random_uuid(),f.league_id,f.season_id,f.member_ids[1],0,0,0);
  PERFORM set_config('pancake.home_changes','{}',true);
  UPDATE pg_temp.standings_current SET points_for=100;
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT scope INTO change FROM public.league_changes WHERE league_id=f.league_id ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.check_rules(change->'homeChanged'='false'::jsonb,'standings point totals do not invalidate Home');
  SET CONSTRAINTS ALL DEFERRED;
  UPDATE pg_temp.standings_current SET wins=1;
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT scope INTO change FROM public.league_changes WHERE league_id=f.league_id ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.check_rules(change->'homeChanged' IS DISTINCT FROM 'false'::jsonb,'weekly wins still invalidate Home');
  SET CONSTRAINTS ALL DEFERRED;
  UPDATE pg_temp.standings_current SET points_for=200;
  SET CONSTRAINTS ALL IMMEDIATE;
  SELECT scope INTO change FROM public.league_changes WHERE league_id=f.league_id ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.check_rules(change->'homeChanged' IS DISTINCT FROM 'false'::jsonb,'a later point update cannot hide a win in the same transaction');
  SET CONSTRAINTS ALL DEFERRED;
  CREATE TEMP TABLE roster_players(id uuid,league_id uuid,league_season_id uuid,member_id uuid);
  CREATE TRIGGER home_roster_hint AFTER UPDATE ON pg_temp.roster_players
    REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
    FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
  INSERT INTO pg_temp.roster_players VALUES(gen_random_uuid(),f.league_id,f.season_id,f.member_ids[1]);
  BEGIN
    UPDATE pg_temp.roster_players SET member_id=f.member_ids[2];
    INSERT INTO public.league_change_hints(league_id,topic,revision,details)
      VALUES(f.league_id,'inventory',1,jsonb_build_array(jsonb_build_object('resource','waivers','season_id',f.season_id)))
      ON CONFLICT(league_id,topic) DO UPDATE SET revision=league_change_hints.revision+1,details=EXCLUDED.details,updated_at=clock_timestamp();
  EXCEPTION WHEN OTHERS THEN RAISE;
  END;
  PERFORM private.publish_league_version(f.league_id,ARRAY['roster','inventory'],ARRAY['roster_players']);
  SELECT scope INTO change FROM public.league_changes WHERE league_id=f.league_id ORDER BY version DESC LIMIT 1;
  PERFORM pg_temp.check_rules(change->'hints' @> jsonb_build_array(jsonb_build_object('topic','inventory',
    'details',jsonb_build_array(jsonb_build_object('resource','waivers','season_id',f.season_id)))),'subtransaction inventory scope reaches the version');
  PERFORM pg_temp.check_rules(change->'hints' @> jsonb_build_array(jsonb_build_object('topic','roster',
    'scopes',jsonb_build_array(jsonb_build_object('season_id',f.season_id,'member_id',f.member_ids[2])))),'subtransaction roster scope reaches the version');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
