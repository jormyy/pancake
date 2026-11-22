-- Canonical SQL source for public.mark_tipoff_ir_member_done.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.mark_tipoff_ir_member_done(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_scope text DEFAULT ''
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at AND scope = p_scope FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF p_tipoff_at <= now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Tipoff window has closed.' USING ERRCODE = '40001';
  END IF;
  IF NOT private.tipoff_scope_admits(p_scope, p_league_id, true) THEN
    RAISE EXCEPTION 'Tipoff scope is no longer active.' USING ERRCODE = 'PT410';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.league_members member
    JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
    JOIN public.league_seasons season ON season.id = p_league_season_id
      AND season.league_id = league.id AND season.is_current
    WHERE member.id = p_member_id AND member.league_id = p_league_id
      AND private.league_auto_ir_all_members(p_league_id)
  ) THEN
    RAISE EXCEPTION 'Auto IR member not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision, ir_done)
  VALUES(p_tipoff_at, p_scope, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, true)
  ON CONFLICT (tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
  DO UPDATE SET ir_done = true;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at AND scope = p_scope;
  END IF;
  RETURN true;
END;
$$;
