BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.lineup_tipoff_members ADD COLUMN error text;

CREATE OR REPLACE FUNCTION private.prevent_locked_lineup_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row_data public.weekly_lineups%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.leagues WHERE id=OLD.league_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.member_id, OLD.league_id, OLD.league_season_id, OLD.player_id, OLD.game_date, OLD.slot_type)
    IS NOT DISTINCT FROM (NEW.member_id, NEW.league_id, NEW.league_season_id, NEW.player_id, NEW.game_date, NEW.slot_type) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN row_data := NEW; ELSE row_data := OLD; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(row_data.league_id::text), hashtext(row_data.member_id::text));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_pre_tipoff_lineup_failure(
  p_tipoff_at timestamptz, p_token uuid, p_league_id uuid,
  p_league_season_id uuid, p_member_id uuid, p_error text
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
   WHERE tipoff_at = p_tipoff_at FOR UPDATE;
  IF NOT FOUND OR v_dispatch.token IS DISTINCT FROM p_token OR v_dispatch.status <> 'running'
     OR v_dispatch.lease_until IS NULL OR v_dispatch.lease_until <= clock_timestamp()
     OR v_dispatch.game_date <> (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'Tipoff claim is no longer current.' USING ERRCODE = '40001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lineup_optimizer_settings
    WHERE league_id = p_league_id AND league_season_id = p_league_season_id AND member_id = p_member_id) THEN
    RAISE EXCEPTION 'Optimizer setting not found.' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.lineup_tipoff_members(tipoff_at, league_id, league_season_id, member_id, input_revision, error)
  VALUES(p_tipoff_at, p_league_id, p_league_season_id, p_member_id, v_dispatch.input_revision, left(p_error, 4000))
  ON CONFLICT (tipoff_at, league_id, league_season_id, member_id, input_revision) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_pre_tipoff_lineup_failure(timestamptz, uuid, uuid, uuid, uuid, text) TO service_role;

COMMIT;
