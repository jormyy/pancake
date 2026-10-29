-- Canonical SQL source for public.advance_season_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.advance_season_atomic(p_league_id uuid)
RETURNS TABLE(new_season_id uuid, new_year int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_new_season_id uuid;
  v_new_year int;
  v_far_year int;
  v_previous_flag text;
BEGIN
  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found';
  END IF;

  IF v_league.status NOT IN ('playoffs'::league_status, 'archived'::league_status) THEN
    RAISE EXCEPTION 'League must be in playoffs or archived state before advancing season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found for this league';
  END IF;

  -- Prior+1 alone breaks a league that skipped a season or was created
  -- off-cycle: the derived year would never match season_weeks. The real
  -- calendar wins whenever it is ahead.
  v_new_year := GREATEST(
    v_current_season.season_year + 1,
    public.current_season_year_et(now())
  );
  v_far_year := v_new_year + v_league.future_pick_years;

  UPDATE draft_picks SET is_used=true,used_at=now()
    WHERE league_id=p_league_id AND season_year<v_new_year AND NOT is_used;

  IF EXISTS (
    SELECT 1
      FROM league_seasons
     WHERE league_id = p_league_id
       AND season_year = v_new_year
  ) THEN
    RAISE EXCEPTION 'Season % already exists', v_new_year;
  END IF;

  v_previous_flag := private.begin_trade_lifecycle_write();
  UPDATE trades
     SET status = 'expired',
         completion_failure_reason = 'The season rolled over before this offer was accepted.'
   WHERE league_id = p_league_id
     AND league_season_id = v_current_season.id
     AND status = 'pending';
  PERFORM private.end_trade_lifecycle_write(v_previous_flag);

  UPDATE league_seasons
     SET is_current = false
   WHERE id = v_current_season.id;

  INSERT INTO league_seasons (league_id, season_year, is_current, rookie_draft_scheduled_at)
  VALUES (p_league_id, v_new_year, true, now() + interval '60 days')
  RETURNING id INTO v_new_season_id;

  PERFORM private.authorize_taxi_acquisition(p_league_id,v_new_season_id,member_id,player_id,'carry_over',v_current_season.id)
    FROM roster_players WHERE league_id=p_league_id AND league_season_id=v_current_season.id AND is_on_taxi;

  INSERT INTO roster_players (
    league_id,
    league_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
    acquired_via
  )
  SELECT
    p_league_id,
    v_new_season_id,
    member_id,
    player_id,
    is_on_ir,
    is_on_taxi,
    taxi_start_season_year,
    'carry_over'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_current_season.id;

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    'carry_over',
    acquired_at
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over';

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type,
    occurred_at
  )
  SELECT
    league_id,
    league_season_id,
    member_id,
    player_id,
    CASE WHEN is_on_ir THEN 'ir_designate' ELSE 'taxi_designate' END,
    acquired_at + interval '1 millisecond'
  FROM roster_players
  WHERE league_id = p_league_id
    AND league_season_id = v_new_season_id
    AND acquired_via = 'carry_over'
    AND (is_on_ir = true OR is_on_taxi = true);

  INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
  SELECT current.league_id,current.league_season_id,current.member_id,current.player_id,'taxi_return',current.acquired_at+interval '1 millisecond'
  FROM roster_players current JOIN roster_players previous ON previous.league_season_id=v_current_season.id
    AND previous.member_id=current.member_id AND previous.player_id=current.player_id
  WHERE current.league_season_id=v_new_season_id AND previous.is_on_taxi AND NOT current.is_on_taxi;

  -- Fill skipped pick years and preserve existing owners.
  INSERT INTO draft_picks (
    league_id,
    season_year,
    round,
    original_owner_id,
    current_owner_id
  )
  SELECT
    p_league_id,
    year_value,
    round_value,
    lm.id,
    lm.id
  FROM league_members lm
  CROSS JOIN generate_series(v_new_year,v_far_year) AS year_value
  CROSS JOIN unnest(ARRAY[1, 2, 3]) AS round_value
  WHERE lm.league_id = p_league_id
  ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING;

  INSERT INTO waiver_priorities (
    league_id,
    league_season_id,
    member_id,
    priority
  )
  WITH latest_standings AS (
    SELECT DISTINCT ON (member_id)
      member_id,
      wins,
      losses,
      ties,
      points_for,
      points_against
    FROM standings
    WHERE league_id = p_league_id
      AND league_season_id = v_current_season.id
    ORDER BY member_id, week_number DESC
  ),
  ordered_members AS (
    SELECT
      lm.id AS member_id,
      row_number() OVER (
        ORDER BY
          (COALESCE(ls.wins, 0) + 0.5 * COALESCE(ls.ties, 0)) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
          COALESCE(ls.points_for, 0) / GREATEST(COALESCE(ls.wins + ls.losses + ls.ties, 0), 1) ASC,
          COALESCE(ls.losses, 0) DESC,
          COALESCE(ls.points_against, 0) DESC,
          lm.id ASC
      ) AS priority
    FROM league_members lm
    LEFT JOIN latest_standings ls ON ls.member_id = lm.id
    WHERE lm.league_id = p_league_id
  )
  SELECT p_league_id, v_new_season_id, member_id, priority
  FROM ordered_members;

  -- The trade deadline repeats every season.
  UPDATE leagues
     SET status = 'offseason',
         trade_deadline = private.trade_deadline_for_season(trade_deadline, v_new_year)
   WHERE id = p_league_id;

  new_season_id := v_new_season_id;
  new_year := v_new_year;
  RETURN NEXT;
END;
$$;
