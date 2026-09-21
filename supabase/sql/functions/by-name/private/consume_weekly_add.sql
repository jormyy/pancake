-- Canonical SQL source for private.consume_weekly_add.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.consume_weekly_add(
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
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, p_league_season_id);

  UPDATE weekly_add_counts AS count_row
     SET add_count = count_row.add_count + 1,
         updated_at = now()
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week;
END;
$$;
