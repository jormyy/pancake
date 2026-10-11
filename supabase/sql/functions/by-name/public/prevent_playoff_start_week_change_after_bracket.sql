-- Canonical SQL source for public.prevent_playoff_start_week_change_after_bracket.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.prevent_playoff_start_week_change_after_bracket()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season public.league_seasons%ROWTYPE;
  v_rounds int[];
  v_members int;
  v_had_schedule boolean;
  v_had_bracket boolean;
BEGIN
  -- The league UPDATE already holds the first lock. Every schedule writer
  -- takes league, season, advisory locks, then matchup rows in that order.
  SELECT * INTO v_season FROM public.league_seasons
   WHERE league_id = NEW.id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found. Playoff settings were not changed.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(v_season.id::text));
  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season.id::text));
  PERFORM 1 FROM public.matchups WHERE league_season_id = v_season.id FOR UPDATE;
  v_had_schedule := FOUND;
  SELECT EXISTS (SELECT 1 FROM public.matchups WHERE league_season_id = v_season.id AND matchup_type <> 'regular_season') INTO v_had_bracket;
  PERFORM private.assert_schedule_not_started(v_season.id);
  SELECT count(*) INTO v_members FROM public.league_members WHERE league_id = NEW.id;
  v_rounds := private.playoff_round_plan(v_members, NEW.playoff_total_weeks, NEW.playoff_round_weeks);
  PERFORM private.assert_playoff_window(v_season.season_year, NEW.playoff_start_week, v_rounds, true);
  UPDATE public.league_seasons
     SET playoff_start_week = NEW.playoff_start_week, playoff_round_weeks = NULL, playoff_seed_member_ids = NULL
   WHERE id = v_season.id;
  IF v_had_schedule THEN
    DELETE FROM public.matchups WHERE league_season_id = v_season.id;
    -- A changed future schedule gets fresh standings tie evidence at seeding.
    DELETE FROM public.rps_challenges WHERE league_season_id = v_season.id AND context = 'standings_playoff_tiebreaker';
    PERFORM public.replace_regular_season_matchups_atomic(NEW.id, v_season.id, false,
      private.regular_season_matchup_payload(NEW.id, v_season.id, NEW.playoff_start_week - 1));
    IF v_had_bracket AND NEW.playoff_start_week = 1 THEN
      PERFORM public.generate_playoff_bracket_atomic(NEW.id);
    ELSIF v_had_bracket AND NEW.status = 'playoffs' THEN
      UPDATE public.leagues SET status = 'active' WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
