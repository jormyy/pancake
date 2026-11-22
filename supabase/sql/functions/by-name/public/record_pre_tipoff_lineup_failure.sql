-- Canonical SQL source for public.record_pre_tipoff_lineup_failure.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.record_pre_tipoff_lineup_failure(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_error text, p_scope text DEFAULT ''
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_error IS NULL OR btrim(p_error) = '' THEN
    RAISE EXCEPTION 'A member failure requires an error.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    IF p_scope = '' THEN RETURN; END IF;
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lineup_optimizer_settings
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id)
     AND NOT (private.league_auto_ir_all_members(p_league_id) AND EXISTS (
       SELECT 1 FROM public.league_members member
       WHERE member.id = p_member_id AND member.league_id = p_league_id)) THEN
    RAISE EXCEPTION 'Optimizer setting not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision, error)
  VALUES(p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, left(p_error, 4000))
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  DO UPDATE SET error = CASE WHEN public.lineup_tipoff_members.starter_done
    THEN public.lineup_tipoff_members.error
    ELSE COALESCE(public.lineup_tipoff_members.error, EXCLUDED.error) END;
END;
$$;
