-- Canonical SQL source for public.trade_roster_hold_check.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.trade_roster_hold_check(
  p_member_id uuid,
  p_user_id uuid,
  p_add_player_id uuid DEFAULT NULL,
  p_drop_player_ids uuid[] DEFAULT '{}'::uuid[],
  p_to_ir boolean DEFAULT false,
  p_to_taxi boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member league_members%ROWTYPE;
  v_season_id uuid;
BEGIN
  SELECT * INTO v_member FROM league_members WHERE id = p_member_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_season_id FROM league_seasons WHERE league_id = v_member.league_id AND is_current = true LIMIT 1;
  IF v_season_id IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN private.trade_hold_conflicts(
    v_member.league_id,
    v_season_id,
    p_member_id,
    jsonb_build_object(
      'addPlayerId', p_add_player_id,
      'dropPlayerIds', to_jsonb(COALESCE(p_drop_player_ids, '{}'::uuid[])),
      'toIr', COALESCE(p_to_ir, false),
      'toTaxi', COALESCE(p_to_taxi, false)
    ),
    'add',
    NULL,
    false,
    p_member_id,
    NULL
  );
END;
$$;
