-- Canonical SQL source for private.assert_weekly_add_available.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_weekly_add_available(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_week int;
  v_resets_at timestamptz;
  v_used int;
  v_message text;
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  SELECT week.week_number, week.resets_at
    INTO v_week, v_resets_at
    FROM private.current_add_week(p_league_id, p_league_season_id) AS week;

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  SELECT count_row.add_count
    INTO v_used
    FROM weekly_add_counts AS count_row
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week
   FOR UPDATE;

  -- PA001 is the weekly add limit; the app classifies on the code.
  v_message := private.weekly_add_limit_message(v_used, v_limit, v_resets_at);
  IF v_message IS NOT NULL THEN
    RAISE EXCEPTION '%', v_message USING ERRCODE = 'PA001';
  END IF;
END;
$$;
