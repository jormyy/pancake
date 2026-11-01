-- Canonical SQL source for private.league_version_capture.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.league_version_capture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed_sql text; leagues_sql text; affected record;
  ignored text[] := ARRAY['updated_at','set_at'];
  home_changes jsonb; home_changed boolean;
BEGIN
  IF TG_TABLE_NAME IN ('standings_current','matchup_totals','player_season_averages','trade_value_cache') THEN
    ignored := ignored||ARRAY['version','refreshed_at'];
  END IF;
  IF TG_TABLE_NAME='profiles' THEN ignored := ignored||ARRAY['push_token','push_token_revocation_hash']; END IF;
  IF TG_TABLE_NAME='nba_games' THEN
    ignored := ignored||ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds','stats_synced_at'];
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM version_new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM version_old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(
      (SELECT to_jsonb(n)-ignored FROM version_new_rows n EXCEPT SELECT to_jsonb(o)-ignored FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-ignored FROM version_old_rows o EXCEPT SELECT to_jsonb(n)-ignored FROM version_new_rows n)) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='standings_current' THEN
    home_changed:=true;
    IF TG_OP='UPDATE' THEN
      SELECT EXISTS(
        (SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n
          EXCEPT SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o)
        UNION ALL
        (SELECT jsonb_build_array(o.member_id,o.league_season_id,o.wins,o.losses) FROM version_old_rows o
          EXCEPT SELECT jsonb_build_array(n.member_id,n.league_season_id,n.wins,n.losses) FROM version_new_rows n)
      ) INTO home_changed;
    END IF;
    home_changes:=COALESCE(NULLIF(current_setting('pancake.home_changes',true),'')::jsonb,'{}'::jsonb);
    PERFORM set_config('pancake.home_changes',jsonb_set(home_changes,ARRAY[TG_TABLE_NAME],
      to_jsonb(COALESCE((home_changes->>TG_TABLE_NAME)::boolean,false) OR home_changed))::text,true);
  END IF;
  IF TG_OP='INSERT' THEN changed_sql := 'SELECT to_jsonb(n) AS data FROM version_new_rows n';
  ELSIF TG_OP='DELETE' THEN changed_sql := 'SELECT to_jsonb(o) AS data FROM version_old_rows o';
  ELSE
    changed_sql := format($rows$
      (SELECT to_jsonb(n)-%L::text[] AS data FROM version_new_rows n
       EXCEPT SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o
       EXCEPT SELECT to_jsonb(n)-%L::text[] FROM version_new_rows n)
    $rows$,ignored,ignored,ignored,ignored);
  END IF;
  CASE TG_ARGV[1]
    WHEN 'league' THEN leagues_sql := 'SELECT (data->>''league_id'')::uuid AS league_id FROM changed';
    WHEN 'user' THEN leagues_sql := 'SELECT member.league_id FROM changed JOIN public.league_members member ON member.user_id=COALESCE((data->>''user_id'')::uuid,(data->>''id'')::uuid)';
    WHEN 'self' THEN leagues_sql := 'SELECT (data->>''id'')::uuid AS league_id FROM changed';
    WHEN 'draft' THEN leagues_sql := 'SELECT draft.league_id FROM changed JOIN public.drafts draft ON draft.id=(data->>''draft_id'')::uuid';
    WHEN 'trade' THEN leagues_sql := 'SELECT trade.league_id FROM changed JOIN public.trades trade ON trade.id=(data->>''trade_id'')::uuid';
    WHEN 'season' THEN leagues_sql := 'SELECT season.league_id FROM changed JOIN public.league_seasons season ON season.season_year=(data->>''season_year'')::integer';
    WHEN 'global' THEN leagues_sql := 'SELECT league.id AS league_id FROM public.leagues league WHERE league.deleted_at IS NULL AND EXISTS(SELECT 1 FROM changed)';
    ELSE RAISE EXCEPTION 'Unsupported league version source: %',TG_TABLE_NAME;
  END CASE;
  FOR affected IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM (%s) affected WHERE league_id IS NOT NULL ORDER BY league_id',changed_sql,leagues_sql) LOOP
    PERFORM private.league_version_enqueue(affected.league_id,TG_ARGV[0],TG_TABLE_NAME);
  END LOOP;
  RETURN NULL;
END;
$$;
