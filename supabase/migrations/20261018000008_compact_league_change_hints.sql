SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE TABLE public.league_change_hints (
  league_id uuid NOT NULL,
  topic text NOT NULL CHECK(topic IN ('lineup','roster','score','game','stat')),
  revision bigint NOT NULL CHECK(revision>0),
  scopes jsonb CHECK(scopes IS NULL OR (jsonb_typeof(scopes)='array' AND jsonb_array_length(scopes)<=16)),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(league_id,topic)
);
ALTER TABLE public.league_change_hints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_change_hints FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.league_change_hints TO authenticated,service_role;
CREATE POLICY league_change_member_read ON public.league_change_hints FOR SELECT TO authenticated
  USING(private.is_league_member(league_id));

CREATE OR REPLACE FUNCTION private.emit_league_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_scopes text; v_topic text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','set_at']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','set_at'])
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-ARRAY['updated_at','set_at']) IS DISTINCT FROM (to_jsonb(o)-ARRAY['updated_at','set_at'])$rows$;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'weekly_lineups' THEN
      v_topic := 'lineup';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'member_id',member_id,'date',game_date) AS scope FROM changed$scopes$;
    WHEN 'roster_players' THEN
      v_topic := 'roster';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'member_id',member_id) AS scope FROM changed$scopes$;
    WHEN 'matchups' THEN
      v_topic := 'score';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'week',week_number) AS scope FROM changed$scopes$;
    WHEN 'nba_games' THEN
      v_topic := 'game';
      v_scopes := $scopes$SELECT season.league_id,jsonb_build_object('season_id',season.id,'date',game.game_date) AS scope
        FROM changed game JOIN public.league_seasons season ON season.season_year=game.season_year
        WHERE game.nba_game_id LIKE '002%'$scopes$;
    WHEN 'player_game_stats' THEN
      v_topic := 'stat';
      v_scopes := $scopes$SELECT roster.league_id,jsonb_build_object('season_id',roster.league_season_id,'date',stat.game_date) AS scope
        FROM changed stat JOIN public.nba_games game ON game.id=stat.game_id AND game.nba_game_id LIKE '002%'
        JOIN public.roster_players roster ON roster.player_id=stat.player_id
        JOIN public.league_seasons season ON season.id=roster.league_season_id AND season.season_year=stat.season_year
        UNION SELECT lineup.league_id,jsonb_build_object('season_id',lineup.league_season_id,'date',stat.game_date) AS scope
        FROM changed stat JOIN public.nba_games game ON game.id=stat.game_id AND game.nba_game_id LIKE '002%'
        JOIN public.weekly_lineups lineup ON lineup.player_id=stat.player_id AND lineup.game_date=stat.game_date$scopes$;
    ELSE RAISE EXCEPTION 'Unsupported league change source';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),scopes AS (%s),distinct_scopes AS (
      SELECT DISTINCT scopes.league_id,scopes.scope FROM scopes
      JOIN public.leagues league ON league.id=scopes.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 THEN jsonb_agg(scope ORDER BY scope::text) END AS scopes
      FROM distinct_scopes GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_scopes) LOOP
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes)
      VALUES(v_change.league_id,v_topic,1,v_change.scopes)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,
      scopes=EXCLUDED.scopes,updated_at=clock_timestamp();
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.emit_league_change() FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER compact_change_insert AFTER INSERT ON public.weekly_lineups
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_update AFTER UPDATE ON public.weekly_lineups
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_delete AFTER DELETE ON public.weekly_lineups
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_insert AFTER INSERT ON public.roster_players
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_update AFTER UPDATE ON public.roster_players
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_delete AFTER DELETE ON public.roster_players
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_insert AFTER INSERT ON public.matchups
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_update AFTER UPDATE ON public.matchups
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_delete AFTER DELETE ON public.matchups
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_insert AFTER INSERT ON public.nba_games
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_update AFTER UPDATE ON public.nba_games
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_delete AFTER DELETE ON public.nba_games
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_insert AFTER INSERT ON public.player_game_stats
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_update AFTER UPDATE ON public.player_game_stats
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();
CREATE TRIGGER compact_change_delete AFTER DELETE ON public.player_game_stats
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.emit_league_change();

ALTER PUBLICATION supabase_realtime ADD TABLE public.league_change_hints;
RESET statement_timeout;
RESET lock_timeout;
