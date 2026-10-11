-- Player revisions exist independently of roster membership, including uncommitted new links.
-- Unrelated imports do not invalidate every league; retained history remains a dependency.
BEGIN;

CREATE OR REPLACE FUNCTION private.track_score_input_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row jsonb;
  v_keys text[] := ARRAY[]::text[];
  v_fields text[] := string_to_array(TG_ARGV[1], ',');
  v_old_fields jsonb;
  v_new_fields jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(key, value) INTO v_old_fields FROM jsonb_each(v_old) WHERE key = ANY(v_fields);
    SELECT jsonb_object_agg(key, value) INTO v_new_fields FROM jsonb_each(v_new) WHERE key = ANY(v_fields);
    IF v_old_fields IS NOT DISTINCT FROM v_new_fields THEN RETURN NEW; END IF;
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(v_old, v_new)) WHERE value <> 'null'::jsonb LOOP
    IF TG_ARGV[0] = 'nba' THEN
      v_keys := v_keys || COALESCE(ARRAY(
        SELECT 'nba:' || season_year || ':' || week_number FROM public.season_weeks
        WHERE season_year = (v_row->>'season_year')::int
          AND (v_row->>'game_date')::date BETWEEN week_start AND week_end
      ), ARRAY[]::text[]);
    ELSIF TG_ARGV[0] = 'calendar' THEN
      v_keys := array_append(v_keys, 'calendar:' || (v_row->>'season_year'));
    ELSIF TG_ARGV[0] = 'players' THEN
      v_keys := array_append(v_keys, 'player:' || (v_row->>'id'));
    ELSIF TG_ARGV[0] = 'league' THEN
      v_keys := array_append(v_keys, 'league:' || CASE WHEN TG_TABLE_NAME = 'leagues' THEN v_row->>'id' ELSE v_row->>'league_id' END);
    ELSIF TG_ARGV[0] = 'season' THEN
      v_keys := array_append(v_keys, 'season:' || (v_row->>'league_season_id'));
    ELSIF TG_ARGV[0] = 'lineup' THEN
      v_keys := array_append(v_keys, 'lineup:' || (v_row->>'league_season_id') || ':' || (v_row->>'week_number'));
    ELSIF TG_ARGV[0] = 'result' THEN
      v_keys := array_append(v_keys, 'result:' || (v_row->>'league_season_id') || ':' || (v_row->>'week_number'));
    END IF;
  END LOOP;
  PERFORM private.bump_score_input_revisions(v_keys);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION private.score_input_keys(p_season_id uuid, p_week int)
RETURNS TABLE(scope text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH season AS (
    SELECT id, league_id, season_year FROM public.league_seasons WHERE id = p_season_id
  ), bounds AS (
    SELECT CASE WHEN bool_or(matchup_type = 'regular_season') THEN 1 ELSE p_week END AS first_week,
      COALESCE(max(COALESCE(end_week_number, week_number)), p_week) AS last_week
    FROM public.matchups WHERE league_season_id = p_season_id AND week_number = p_week
  ), keys AS (
    SELECT unnest(ARRAY['calendar:' || season_year, 'league:' || league_id, 'season:' || id]) AS scope FROM season
    UNION ALL SELECT 'player:' || dependency.player_id FROM (
      SELECT player_id FROM public.roster_players WHERE league_season_id = p_season_id
      UNION SELECT player_id FROM public.roster_transactions WHERE league_season_id = p_season_id
    ) dependency
    UNION ALL SELECT 'nba:' || season_year || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'lineup:' || id || ':' || week FROM season, bounds, generate_series(first_week, last_week) week
    UNION ALL SELECT 'result:' || id || ':' || week FROM season, bounds, generate_series(first_week, p_week) week
  ) SELECT DISTINCT scope FROM keys ORDER BY scope;
$$;

DROP TRIGGER score_revision_season ON public.roster_transactions;
CREATE TRIGGER score_revision_season AFTER INSERT OR UPDATE OR DELETE ON public.roster_transactions FOR EACH ROW EXECUTE FUNCTION private.track_score_input_revision('season', 'id,league_season_id,member_id,player_id,transaction_type,occurred_at');
COMMIT;
