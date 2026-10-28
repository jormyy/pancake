-- Canonical SQL source for public.set_waiver_clears_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_eligible_at timestamptz;
  v_run_at timestamp;
  v_timezone text;
BEGIN
  IF TG_TABLE_NAME='leagues' THEN
WITH eligible AS (
  SELECT wire.id, wire.placed_on_waivers_at + interval '48 hours' AS eligible_at,
    coalesce(league.timezone, 'America/Los_Angeles') AS timezone
  FROM public.waiver_wire_log wire JOIN public.leagues league ON league.id=wire.league_id
  WHERE wire.cleared_at IS NULL AND league.id=NEW.id
), scheduled AS (
  SELECT id, eligible_at, timezone, (eligible_at AT TIME ZONE timezone)::date AS day FROM eligible
)
UPDATE public.waiver_wire_log wire
SET clears_at=(scheduled.day + CASE WHEN scheduled.day::timestamp AT TIME ZONE scheduled.timezone < scheduled.eligible_at THEN 1 ELSE 0 END)::timestamp AT TIME ZONE scheduled.timezone
FROM scheduled WHERE wire.id=scheduled.id;
WITH eligible AS (
  SELECT claim.id, claim.submitted_at, coalesce(league.timezone, 'America/Los_Angeles') AS timezone,
    greatest(claim.submitted_at, max(wire.clears_at)) AS threshold
  FROM public.waiver_claims claim JOIN public.leagues league ON league.id=claim.league_id
  LEFT JOIN public.waiver_wire_log wire ON wire.league_id=claim.league_id AND wire.league_season_id=claim.league_season_id
    AND wire.player_id=claim.player_id AND wire.cleared_at IS NULL
  WHERE claim.status='pending' AND league.id=NEW.id
  GROUP BY claim.id, league.timezone
), scheduled AS (
  SELECT *, (threshold AT TIME ZONE timezone)::date AS day FROM eligible
)
UPDATE public.waiver_claims claim
SET process_date=scheduled.day + CASE WHEN scheduled.day::timestamp AT TIME ZONE scheduled.timezone <= scheduled.submitted_at
  OR scheduled.day::timestamp AT TIME ZONE scheduled.timezone < scheduled.threshold THEN 1 ELSE 0 END
FROM scheduled WHERE claim.id=scheduled.id;
    RETURN NEW;
  END IF;
  v_eligible_at := NEW.placed_on_waivers_at + interval '48 hours';
  SELECT coalesce(timezone, 'America/Los_Angeles') INTO v_timezone FROM leagues WHERE id=NEW.league_id;
  v_run_at := date_trunc('day', v_eligible_at AT TIME ZONE v_timezone);
  IF v_run_at AT TIME ZONE v_timezone < v_eligible_at THEN
    v_run_at := v_run_at + interval '1 day';
  END IF;
  NEW.clears_at := v_run_at AT TIME ZONE v_timezone;
  RETURN NEW;
END;
$$;
