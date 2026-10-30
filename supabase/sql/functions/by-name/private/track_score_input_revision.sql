-- Canonical SQL source for private.track_score_input_revision.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

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
    IF TG_ARGV[0] = 'nba' AND TG_TABLE_NAME = 'nba_games'
        AND v_old->>'stats_synced_at' IS NOT NULL AND v_new->>'stats_synced_at' IS NOT NULL THEN
      v_old_fields := v_old_fields - 'stats_synced_at';
      v_new_fields := v_new_fields - 'stats_synced_at';
    END IF;
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
