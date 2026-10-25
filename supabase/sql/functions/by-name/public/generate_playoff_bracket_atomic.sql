-- Canonical SQL source for public.generate_playoff_bracket_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.generate_playoff_bracket_atomic(
  p_league_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season_id uuid;
  v_season_year int;
  v_playoff_start_week int;
  v_member_count int;
  v_playoff_size int;
  v_rounds int[];
  v_league public.leagues%ROWTYPE;
  v_seed_ids uuid[];
  v_inserted_count int := 0;
  v_seed int;
  v_size int;
  v_type public.matchup_type;
BEGIN
  SELECT * INTO v_league FROM public.leagues WHERE id = p_league_id FOR UPDATE;
  SELECT id, season_year, COALESCE(playoff_start_week, v_league.playoff_start_week, 20)
    INTO v_season_id, v_season_year, v_playoff_start_week
    FROM public.league_seasons WHERE league_id = p_league_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-bracket'), hashtext(v_season_id::text));

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type <> 'regular_season'
   FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = false AND NOT matchup.is_voided
   FOR UPDATE;

  IF FOUND THEN
    RAISE EXCEPTION 'Regular season matchups must be finalized before generating playoffs.';
  END IF;

  PERFORM 1
    FROM public.matchups AS matchup
   WHERE matchup.league_season_id = v_season_id
     AND matchup.matchup_type = 'regular_season'::public.matchup_type
     AND matchup.week_number < v_playoff_start_week
     AND matchup.is_finalized = true
   FOR UPDATE;

  SELECT count(*)
    INTO v_member_count
    FROM public.league_members AS member
   WHERE member.league_id = p_league_id;

  IF v_member_count < COALESCE(v_league.playoff_entrants,4) THEN
    RAISE EXCEPTION 'Not enough teams to seed playoffs (need %).',COALESCE(v_league.playoff_entrants,4);
  END IF;

  v_playoff_size := COALESCE(v_league.playoff_entrants,CASE WHEN v_member_count >= 10 THEN 6 ELSE 4 END);

  v_rounds := private.league_playoff_round_plan(v_league.id, v_member_count);
  PERFORM private.assert_playoff_window(v_season_year, v_playoff_start_week, v_rounds, v_league.playoff_entrants IS NOT NULL);
  UPDATE public.league_seasons
     SET playoff_start_week = v_playoff_start_week, playoff_round_weeks = v_rounds
   WHERE id = v_season_id;

  SELECT array_agg(seed.member_id ORDER BY seed.seed_rank)
    INTO v_seed_ids
    FROM private.playoff_seed_rankings(p_league_id, v_season_id, v_playoff_start_week) AS seed;

  UPDATE public.league_seasons
     SET playoff_seed_member_ids = CASE WHEN v_playoff_size IN (4,6) THEN v_seed_ids[1:v_playoff_size] END,
         playoff_bracket_seed_ids = CASE WHEN v_league.playoff_entrants IS NOT NULL THEN v_seed_ids[1:v_playoff_size] END
   WHERE id = v_season_id;

  IF v_league.playoff_entrants IS NOT NULL THEN
    RETURN private.generate_playoff_round(p_league_id,v_season_id,1);
  END IF;

  v_size := power(2,cardinality(v_rounds))::int;
  v_type := CASE cardinality(v_rounds) WHEN 3 THEN 'playoff_quarterfinal'::public.matchup_type
    WHEN 2 THEN 'playoff_semifinal'::public.matchup_type ELSE 'playoff_final'::public.matchup_type END;
  FOR v_seed IN 1..(v_size/2) LOOP
    IF v_size+1-v_seed <= v_playoff_size THEN
      INSERT INTO public.matchups(league_id,league_season_id,week_number,end_week_number,matchup_type,home_member_id,away_member_id)
      VALUES(p_league_id,v_season_id,v_playoff_start_week,v_playoff_start_week+v_rounds[1]-1,v_type,
        v_seed_ids[v_seed],v_seed_ids[v_size+1-v_seed])
      ON CONFLICT (league_id,league_season_id,week_number,home_member_id,away_member_id) DO NOTHING;
      v_inserted_count := v_inserted_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('inserted',v_inserted_count,'skipped',false);
END;
$$;
