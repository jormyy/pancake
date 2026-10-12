BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Status reads do not initialize mutable budget/count rows or block waiver awards.
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
  add_limit_message text,
  add_limit_resets_label text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_resets_at timestamptz;
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

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, v_season_id) AS week;
  RETURN QUERY
  SELECT
    v_season_id,
    v_week,
    league.weekly_add_limit,
    COALESCE(count_row.add_count, 0),
    league.waiver_mode,
    league.faab_starting_budget,
    COALESCE(balance_row.balance, league.faab_starting_budget, 100),
    v_resets_at,
    private.weekly_add_limit_message(COALESCE(count_row.add_count, 0), league.weekly_add_limit, v_resets_at),
    private.weekly_add_limit_reset_label(v_resets_at)
  FROM leagues AS league
  LEFT JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  LEFT JOIN faab_balances AS balance_row
    ON balance_row.league_id = league.id
   AND balance_row.league_season_id = v_season_id
   AND balance_row.member_id = p_member_id
  WHERE league.id = p_league_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
