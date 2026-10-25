CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_eligible_at timestamptz := NEW.placed_on_waivers_at + interval '48 hours';
  v_run_at timestamp;
BEGIN
  v_run_at := date_trunc('day', v_eligible_at AT TIME ZONE 'America/New_York') + interval '3 hours';
  IF v_run_at AT TIME ZONE 'America/New_York' < v_eligible_at THEN
    v_run_at := v_run_at + interval '1 day';
  END IF;
  NEW.clears_at := v_run_at AT TIME ZONE 'America/New_York';
  RETURN NEW;
END;
$$;

WITH eligible AS (
  SELECT id, placed_on_waivers_at + interval '48 hours' AS eligible_at,
    date_trunc('day', (placed_on_waivers_at + interval '48 hours') AT TIME ZONE 'America/New_York') + interval '3 hours' AS run_at
  FROM public.waiver_wire_log
  WHERE cleared_at IS NULL
), scheduled AS (
  SELECT id, (CASE WHEN run_at AT TIME ZONE 'America/New_York' < eligible_at
    THEN run_at + interval '1 day' ELSE run_at END) AT TIME ZONE 'America/New_York' AS clears_at
  FROM eligible
)
UPDATE public.waiver_wire_log AS entry
SET clears_at = scheduled.clears_at
FROM scheduled
WHERE entry.id = scheduled.id AND entry.clears_at IS DISTINCT FROM scheduled.clears_at;

UPDATE public.waiver_claims claim
SET process_date=(entry.clears_at AT TIME ZONE 'America/New_York')::date
FROM public.waiver_wire_log entry
WHERE claim.league_id=entry.league_id AND claim.league_season_id=entry.league_season_id
  AND claim.player_id=entry.player_id AND claim.status='pending' AND entry.cleared_at IS NULL
  AND claim.process_date IS DISTINCT FROM (entry.clears_at AT TIME ZONE 'America/New_York')::date;
