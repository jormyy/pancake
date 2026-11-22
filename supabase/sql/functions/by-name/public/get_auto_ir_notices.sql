-- Canonical SQL source for public.get_auto_ir_notices.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_auto_ir_notices(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_member_id uuid;
  v_enabled boolean;
  v_league_auto_ir boolean;
  v_plan jsonb;
BEGIN
  SELECT member.id INTO v_member_id
    FROM league_members member
   WHERE member.league_id = p_league_id
     AND member.id IN (SELECT private.my_member_ids())
   LIMIT 1;
  IF v_member_id IS NULL THEN
    RETURN jsonb_build_object('enabled', false, 'notices', '[]'::jsonb);
  END IF;

  SELECT enabled INTO v_enabled
    FROM lineup_optimizer_settings
   WHERE league_id = p_league_id
     AND league_season_id = p_league_season_id
     AND member_id = v_member_id;
  v_league_auto_ir := private.league_auto_ir_all_members(p_league_id);
  IF NOT COALESCE(v_enabled, false) AND NOT v_league_auto_ir THEN
    RETURN jsonb_build_object('enabled', false, 'notices', '[]'::jsonb);
  END IF;

  v_plan := private.plan_auto_ir(p_league_id, p_league_season_id, v_member_id);
  RETURN jsonb_build_object('enabled', true, 'notices', COALESCE(v_plan->'notices', '[]'::jsonb));
END;
$function$;
