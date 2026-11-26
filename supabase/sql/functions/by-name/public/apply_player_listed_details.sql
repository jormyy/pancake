-- Canonical SQL source for public.apply_player_listed_details.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.apply_player_listed_details(p_source text, p_records jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_matched integer := 0;
  v_updated integer := 0;
  v_conflicts integer := 0;
  v_missing jsonb;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('espn', 'nba_index', 'nba_profile')
    OR p_records IS NULL OR jsonb_typeof(p_records) <> 'array' OR jsonb_array_length(p_records) > 1000 THEN
    RAISE EXCEPTION 'Invalid listed detail source or records.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r
    WHERE jsonb_typeof(r) <> 'object' OR jsonb_typeof(r->'provider_id') IS DISTINCT FROM 'string'
      OR r->>'provider_id' !~ '^[0-9]+$'
      OR EXISTS (SELECT FROM jsonb_object_keys(r) k WHERE NOT k = ANY(CASE p_source
        WHEN 'espn' THEN ARRAY['provider_id', 'height_inches', 'weight_lb']
        WHEN 'nba_index' THEN ARRAY['provider_id', 'draft_year', 'draft_round', 'draft_overall_pick']
        ELSE ARRAY['provider_id', 'draft_status'] END))) THEN
    RAISE EXCEPTION 'Unsupported listed detail field.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r GROUP BY r->>'provider_id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Provider identities must be unique within listed details.' USING ERRCODE = '22023';
  END IF;

  IF p_source = 'espn' THEN
    IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r
      WHERE (r ? 'height_inches' AND jsonb_typeof(r->'height_inches') IS DISTINCT FROM 'number')
        OR (r ? 'weight_lb' AND jsonb_typeof(r->'weight_lb') IS DISTINCT FROM 'number')
        OR NOT (r ? 'height_inches' OR r ? 'weight_lb')) THEN
      RAISE EXCEPTION 'Listed size needs a numeric height or weight.' USING ERRCODE = '22023';
    END IF;
    WITH incoming AS (
      SELECT r->>'provider_id' AS provider_id, (r->>'height_inches')::smallint AS height_inches, (r->>'weight_lb')::smallint AS weight_lb
      FROM jsonb_array_elements(p_records) r),
    matched AS (
      SELECT p.id, i.* FROM incoming i JOIN public.players p ON p.espn_id = i.provider_id),
    changed AS (
      UPDATE public.players p
      SET height_inches = coalesce(m.height_inches, p.height_inches), weight_lb = coalesce(m.weight_lb, p.weight_lb), updated_at = clock_timestamp()
      FROM matched m
      WHERE p.id = m.id
        AND (coalesce(m.height_inches, p.height_inches) IS DISTINCT FROM p.height_inches
          OR coalesce(m.weight_lb, p.weight_lb) IS DISTINCT FROM p.weight_lb)
      RETURNING p.id)
    SELECT (SELECT count(*) FROM matched), (SELECT count(*) FROM changed),
      (SELECT coalesce(jsonb_agg(i.provider_id ORDER BY i.provider_id), '[]') FROM incoming i WHERE NOT EXISTS (SELECT FROM matched m WHERE m.provider_id = i.provider_id))
    INTO v_matched, v_updated, v_missing;
  ELSIF p_source = 'nba_index' THEN
    IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r
      WHERE jsonb_typeof(r->'draft_year') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'draft_round') IS DISTINCT FROM 'number'
        OR jsonb_typeof(r->'draft_overall_pick') IS DISTINCT FROM 'number') THEN
      RAISE EXCEPTION 'An NBA draft record needs its year, round and overall pick.' USING ERRCODE = '22023';
    END IF;
    WITH incoming AS (
      SELECT r->>'provider_id' AS provider_id, (r->>'draft_year')::smallint AS draft_year,
        (r->>'draft_round')::smallint AS draft_round, (r->>'draft_overall_pick')::smallint AS draft_overall_pick
      FROM jsonb_array_elements(p_records) r),
    matched AS (
      SELECT p.id, p.draft_status AS stored_status, i.* FROM incoming i JOIN public.players p ON p.nba_id = i.provider_id),
    changed AS (
      UPDATE public.players p
      SET draft_status = 'drafted', draft_year = m.draft_year, draft_round = m.draft_round,
        draft_overall_pick = m.draft_overall_pick, updated_at = clock_timestamp()
      FROM matched m
      WHERE p.id = m.id
        AND (p.draft_status IS DISTINCT FROM 'drafted' OR p.draft_year IS DISTINCT FROM m.draft_year
          OR p.draft_round IS DISTINCT FROM m.draft_round OR p.draft_overall_pick IS DISTINCT FROM m.draft_overall_pick)
      RETURNING p.id)
    SELECT (SELECT count(*) FROM matched), (SELECT count(*) FROM changed),
      (SELECT count(*) FROM matched WHERE stored_status = 'undrafted'),
      (SELECT coalesce(jsonb_agg(i.provider_id ORDER BY i.provider_id), '[]') FROM incoming i WHERE NOT EXISTS (SELECT FROM matched m WHERE m.provider_id = i.provider_id))
    INTO v_matched, v_updated, v_conflicts, v_missing;
  ELSE
    IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r WHERE r->'draft_status' IS DISTINCT FROM '"undrafted"'::jsonb) THEN
      RAISE EXCEPTION 'A profile record can only verify an undrafted player.' USING ERRCODE = '22023';
    END IF;
    WITH incoming AS (
      SELECT r->>'provider_id' AS provider_id FROM jsonb_array_elements(p_records) r),
    matched AS (
      SELECT p.id, p.draft_status AS stored_status, i.provider_id FROM incoming i JOIN public.players p ON p.nba_id = i.provider_id),
    changed AS (
      UPDATE public.players p SET draft_status = 'undrafted', updated_at = clock_timestamp()
      FROM matched m WHERE p.id = m.id AND p.draft_status IS NULL
      RETURNING p.id)
    SELECT (SELECT count(*) FROM matched), (SELECT count(*) FROM changed),
      (SELECT count(*) FROM matched WHERE stored_status = 'drafted'),
      (SELECT coalesce(jsonb_agg(i.provider_id ORDER BY i.provider_id), '[]') FROM incoming i WHERE NOT EXISTS (SELECT FROM matched m WHERE m.provider_id = i.provider_id))
    INTO v_matched, v_updated, v_conflicts, v_missing;
  END IF;

  RETURN jsonb_build_object('matched', v_matched, 'updated', v_updated, 'conflicts', v_conflicts, 'missing', v_missing);
END;
$$;
