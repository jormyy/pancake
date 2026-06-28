-- Playoff and waiver season hardening:
-- - Prevent saved playoff start weeks that cannot leave room for all playoff rounds.
-- - Prevent season rollover from stranding pending waiver claims or uncleared
--   waiver holds on a no-longer-current season.

UPDATE public.leagues
   SET playoff_start_week = 24
 WHERE playoff_start_week > 24;

ALTER TABLE public.leagues
  DROP CONSTRAINT IF EXISTS leagues_playoff_start_week_check;

ALTER TABLE public.leagues
  ADD CONSTRAINT leagues_playoff_start_week_check
  CHECK (playoff_start_week BETWEEN 18 AND 24);

WITH ranked_standings_rps AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY
        league_id,
        league_season_id,
        LEAST(member_a_id, member_b_id),
        GREATEST(member_a_id, member_b_id)
      ORDER BY
        (winner_member_id IS NULL) ASC,
        created_at ASC,
        id ASC
    ) AS row_number
  FROM public.rps_challenges
  WHERE context = 'standings_playoff_tiebreaker'
)
DELETE FROM public.rps_challenges AS challenge
USING ranked_standings_rps AS ranked
WHERE challenge.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rps_standings_playoff_tiebreaker_pair
  ON public.rps_challenges (
    league_id,
    league_season_id,
    LEAST(member_a_id, member_b_id),
    GREATEST(member_a_id, member_b_id)
  )
  WHERE context = 'standings_playoff_tiebreaker';

CREATE OR REPLACE FUNCTION public.assert_current_season_for_pending_waiver_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = NEW.league_season_id
     AND season.league_id = NEW.league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiver claims can only remain pending for the current league season.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assert_current_season_for_pending_waiver_claim ON public.waiver_claims;

CREATE TRIGGER assert_current_season_for_pending_waiver_claim
  BEFORE INSERT OR UPDATE OF league_id, league_season_id, status ON public.waiver_claims
  FOR EACH ROW
  WHEN (NEW.status = 'pending'::waiver_claim_status)
  EXECUTE FUNCTION public.assert_current_season_for_pending_waiver_claim();

CREATE OR REPLACE FUNCTION public.assert_current_season_for_uncleared_waiver_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = NEW.league_season_id
     AND season.league_id = NEW.league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Waiver holds can only remain uncleared for the current league season.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assert_current_season_for_uncleared_waiver_log ON public.waiver_wire_log;

CREATE TRIGGER assert_current_season_for_uncleared_waiver_log
  BEFORE INSERT OR UPDATE OF league_id, league_season_id, cleared_at ON public.waiver_wire_log
  FOR EACH ROW
  WHEN (NEW.cleared_at IS NULL)
  EXECUTE FUNCTION public.assert_current_season_for_uncleared_waiver_log();

CREATE OR REPLACE FUNCTION public.prevent_season_deactivation_with_pending_waivers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
    FROM waiver_claims AS claim
   WHERE claim.league_id = OLD.league_id
     AND claim.league_season_id = OLD.id
     AND claim.status = 'pending'::waiver_claim_status
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Resolve pending waiver claims and waiver holds before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM waiver_wire_log AS log
   WHERE log.league_id = OLD.league_id
     AND log.league_season_id = OLD.id
     AND log.cleared_at IS NULL
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Resolve pending waiver claims and waiver holds before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS prevent_season_deactivation_with_pending_waivers ON public.league_seasons;

CREATE TRIGGER prevent_season_deactivation_with_pending_waivers
  BEFORE UPDATE OF is_current ON public.league_seasons
  FOR EACH ROW
  WHEN (OLD.is_current = true AND NEW.is_current = false)
  EXECUTE FUNCTION public.prevent_season_deactivation_with_pending_waivers();
