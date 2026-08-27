-- Canonical SQL source for public.get_member_transaction_state.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_member_transaction_state(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS TABLE (
  league_season_id uuid,
  week_number int,
  weekly_add_limit int,
  weekly_add_count int,
  waiver_mode text,
  faab_starting_budget int,
  faab_balance int,
  add_limit_resets_at timestamptz,
  add_week_timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, v_season_id);
  v_balance := private.ensure_faab_balance(p_league_id, v_season_id, p_member_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  RETURN QUERY
  SELECT
    v_season_id,
    v_week,
    league.weekly_add_limit,
    count_row.add_count,
    league.waiver_mode,
    league.faab_starting_budget,
    v_balance,
    private.weekly_add_limit_resets_at(p_league_id, v_season_id),
    'America/New_York'::text
  FROM leagues AS league
  JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  WHERE league.id = p_league_id;
END;
$$;
