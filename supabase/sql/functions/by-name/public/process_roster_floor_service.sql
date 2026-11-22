-- Canonical SQL source for public.process_roster_floor_service.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_roster_floor_service(
  p_league_id uuid DEFAULT NULL,
  p_league_season_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_league record;
  v_result jsonb;
BEGIN
  IF p_league_id IS NOT NULL THEN
    RETURN private.run_league_roster_floor(p_league_id, p_league_season_id);
  END IF;
  FOR v_league IN
    SELECT policy.league_id, season.id AS season_id
      FROM private.league_roster_policies policy
      JOIN public.leagues league
        ON league.id = policy.league_id
       AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status)
      JOIN public.league_seasons season
        ON season.league_id = league.id
       AND season.is_current
     WHERE policy.weekly_roster_floor IS NOT NULL
     ORDER BY policy.league_id
  LOOP
    BEGIN
      v_result := private.run_league_roster_floor(v_league.league_id, v_league.season_id);
    EXCEPTION WHEN OTHERS THEN
      v_result := jsonb_build_object('status', 'failed', 'reason', SQLERRM);
    END;
    v_results := v_results || jsonb_build_array(v_result);
  END LOOP;
  RETURN jsonb_build_object('leagues', v_results);
END;
$$;
