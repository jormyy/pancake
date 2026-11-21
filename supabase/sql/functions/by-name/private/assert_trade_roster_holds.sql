-- Canonical SQL source for private.assert_trade_roster_holds.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_trade_roster_holds(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_extra jsonb DEFAULT NULL,
  p_remedy text DEFAULT 'drop',
  p_include_trade_id uuid DEFAULT NULL,
  p_commit_trade boolean DEFAULT false,
  p_actor_member_id uuid DEFAULT NULL,
  p_baseline jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_conflicts jsonb;
BEGIN
  v_conflicts := private.trade_hold_conflicts(p_league_id, p_season_id, p_member_id, p_extra, p_remedy, p_include_trade_id, p_commit_trade, p_actor_member_id, p_baseline);
  IF jsonb_array_length(v_conflicts) > 0 THEN
    RAISE EXCEPTION '%', v_conflicts->0->>'message'
      USING ERRCODE = 'PT409',
            DETAIL = jsonb_build_object('code', 'roster_hold', 'conflicts', v_conflicts)::text;
  END IF;
END;
$$;
