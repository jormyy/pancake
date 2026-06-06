CREATE OR REPLACE FUNCTION public.clear_ineligible_taxi_players()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_candidate record;
  v_active_count integer;
  v_roster_size integer;
  v_rows integer;
BEGIN
  v_count := 0;

  FOR v_candidate IN
    SELECT rp.id AS roster_player_id,
           rp.league_id,
           rp.league_season_id,
           rp.member_id,
           rp.player_id
      FROM roster_players AS rp
      JOIN players AS p
        ON p.id = rp.player_id
      JOIN league_seasons AS season
        ON season.id = rp.league_season_id
       AND season.is_current = true
      JOIN leagues AS league
        ON league.id = rp.league_id
       AND league.status IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     WHERE rp.is_on_taxi = true
       AND (
         p.nba_draft_number IS NULL
         OR p.years_exp IS DISTINCT FROM 0
       )
     ORDER BY rp.league_id, rp.member_id, rp.player_id
  LOOP
    PERFORM pg_advisory_xact_lock(
      hashtext(v_candidate.league_id::text),
      hashtext(v_candidate.member_id::text)
    );

    PERFORM pg_advisory_xact_lock(
      hashtext(v_candidate.league_id::text),
      hashtext(v_candidate.player_id::text)
    );

    PERFORM 1
      FROM roster_players AS rp
      JOIN players AS p
        ON p.id = rp.player_id
     WHERE rp.id = v_candidate.roster_player_id
       AND rp.is_on_taxi = true
       AND (
         p.nba_draft_number IS NULL
         OR p.years_exp IS DISTINCT FROM 0
       )
     FOR UPDATE OF rp;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT league.roster_size
      INTO v_roster_size
      FROM leagues AS league
     WHERE league.id = v_candidate.league_id
       AND league.status IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status)
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    PERFORM 1
      FROM league_seasons AS season
     WHERE season.id = v_candidate.league_season_id
       AND season.is_current = true
     FOR UPDATE;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    SELECT count(*)
      INTO v_active_count
      FROM roster_players
     WHERE league_id = v_candidate.league_id
       AND league_season_id = v_candidate.league_season_id
       AND member_id = v_candidate.member_id
       AND is_on_ir = false
       AND is_on_taxi = false;

    IF v_active_count >= COALESCE(v_roster_size, 0) THEN
      CONTINUE;
    END IF;

    UPDATE roster_players
       SET is_on_taxi = false
     WHERE id = v_candidate.roster_player_id
       AND is_on_taxi = true;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_ineligible_taxi_players() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_ineligible_taxi_players() FROM anon;
REVOKE ALL ON FUNCTION public.clear_ineligible_taxi_players() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_ineligible_taxi_players() TO service_role;
