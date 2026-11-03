-- Canonical SQL source for public.apply_pre_tipoff_lineup.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.apply_pre_tipoff_lineup(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_assignments jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
  v_enabled boolean;
  v_same boolean;
BEGIN
  SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
   WHERE tipoff_at = p_tipoff_at FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token <> p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.lineup_tipoff_members
    WHERE tipoff_at = p_tipoff_at AND member_id = p_member_id
      AND league_id = p_league_id AND league_season_id = p_league_season_id
      AND input_revision = v_dispatch.input_revision) THEN
    RETURN false;
  END IF;
  IF p_tipoff_at <= now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Tipoff window has closed.' USING ERRCODE = '40001';
  END IF;

  SELECT enabled INTO v_enabled FROM public.lineup_optimizer_settings
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id
     AND member_id = p_member_id FOR UPDATE;
  IF NOT COALESCE(v_enabled, false) THEN RETURN false; END IF;

  v_same := NOT private.apply_scheduled_lineup(v_dispatch.game_date, p_league_id,
    p_league_season_id, p_member_id, p_assignments);
  INSERT INTO public.lineup_tipoff_members (tipoff_at, league_id, league_season_id, member_id, input_revision)
  VALUES (p_tipoff_at, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision);
  UPDATE public.lineup_optimizer_settings SET last_optimized_at = now()
   WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id;
  IF v_dispatch.lease_until <= now() + interval '30 seconds' THEN
    UPDATE public.lineup_tipoff_dispatches SET lease_until = now() + interval '45 seconds'
     WHERE tipoff_at = p_tipoff_at;
  END IF;
  RETURN NOT v_same;
END;
$$;
