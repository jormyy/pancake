CREATE OR REPLACE FUNCTION private.league_version_enqueue(p_league_id uuid,p_topic text,p_source text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.league_version_pending AS pending(transaction_id,league_id,topics,sources)
    VALUES(pg_current_xact_id(),p_league_id,ARRAY[p_topic],ARRAY[p_source])
  ON CONFLICT(transaction_id,league_id) DO UPDATE SET
    topics=ARRAY(SELECT DISTINCT unnest(pending.topics||EXCLUDED.topics) ORDER BY 1),
    sources=ARRAY(SELECT DISTINCT unnest(pending.sources||EXCLUDED.sources) ORDER BY 1)
  WHERE NOT pending.topics @> EXCLUDED.topics OR NOT pending.sources @> EXCLUDED.sources;
$$;


CREATE OR REPLACE FUNCTION private.emit_league_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_scopes text; v_topic text; v_change record;
  v_ignored text[] := ARRAY['updated_at','set_at'];
BEGIN
  IF TG_TABLE_NAME='nba_games' THEN
    v_ignored := v_ignored || ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds'];
  END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := format($rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-%L::text[]) IS DISTINCT FROM (to_jsonb(o)-%L::text[])
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-%L::text[]) IS DISTINCT FROM (to_jsonb(o)-%L::text[])$rows$,v_ignored,v_ignored,v_ignored,v_ignored);
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
    ON CONFLICT(league_id,topic) DO UPDATE SET
      revision=stored.revision+(stored.xmin<>pg_current_xact_id()::xid)::integer,
      scopes=CASE WHEN stored.xmin<>pg_current_xact_id()::xid THEN EXCLUDED.scopes
        WHEN stored.scopes IS NULL OR EXCLUDED.scopes IS NULL THEN NULL
        WHEN (SELECT count(DISTINCT scope) FROM jsonb_array_elements(stored.scopes||EXCLUDED.scopes) scope)>16 THEN NULL
        ELSE (SELECT jsonb_agg(scope ORDER BY scope::text) FROM
          (SELECT DISTINCT scope FROM jsonb_array_elements(stored.scopes||EXCLUDED.scopes) scope) merged) END,
      updated_at=clock_timestamp()
    WHERE stored.xmin<>pg_current_xact_id()::xid
      OR stored.scopes IS NOT NULL AND (EXCLUDED.scopes IS NULL OR NOT stored.scopes @> EXCLUDED.scopes);
  END LOOP;
  RETURN NULL;
END;
$$;
