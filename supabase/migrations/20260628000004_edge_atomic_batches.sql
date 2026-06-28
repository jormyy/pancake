-- Move the last service-role Edge orchestration writes into bounded,
-- advisory-locked SECURITY DEFINER RPCs. Edge functions may still calculate
-- candidate rows, but SQL owns durable schedule/bracket writes and cron batches.

CREATE OR REPLACE FUNCTION public.replace_regular_season_matchups_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_force boolean DEFAULT false,
  p_matchups jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_count int;
  v_inserted_count int := 0;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('regular-season-matchups'), hashtext(p_league_season_id::text));

  PERFORM 1
    FROM public.league_seasons AS season
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for matchup generation.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     WHERE requested.league_id IS DISTINCT FROM p_league_id
        OR requested.league_season_id IS DISTINCT FROM p_league_season_id
        OR requested.week_number IS NULL
        OR requested.week_number < 1
        OR requested.matchup_type IS DISTINCT FROM 'regular_season'
        OR requested.home_member_id IS NULL
        OR requested.away_member_id IS NULL
        OR requested.home_member_id = requested.away_member_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.home_member_id
             AND member.league_id = p_league_id
        )
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.away_member_id
             AND member.league_id = p_league_id
        )
  ) THEN
    RAISE EXCEPTION 'p_matchups contains invalid regular-season rows.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     GROUP BY
        requested.league_id,
        requested.league_season_id,
        requested.week_number,
        requested.matchup_type,
        LEAST(requested.home_member_id::text, requested.away_member_id::text),
        GREATEST(requested.home_member_id::text, requested.away_member_id::text)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matchups contains duplicate weekly pairings.';
  END IF;

  SELECT count(*)
    INTO v_existing_count
    FROM public.matchups
   WHERE league_season_id = p_league_season_id;

  IF v_existing_count > 0 AND p_force IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  IF v_existing_count > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM public.matchups
       WHERE league_season_id = p_league_season_id
         AND (
           is_finalized = true
           OR matchup_type IN (
             'playoff_quarterfinal'::public.matchup_type,
             'playoff_semifinal'::public.matchup_type,
             'playoff_final'::public.matchup_type
           )
         )
    ) THEN
      RAISE EXCEPTION 'Cannot force-regenerate matchups after finalized or playoff matchups exist.';
    END IF;

    DELETE FROM public.matchups
     WHERE league_season_id = p_league_season_id;
  END IF;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
  ),
  inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    SELECT
      requested.league_id,
      requested.league_season_id,
      requested.week_number,
      requested.matchup_type::public.matchup_type,
      requested.home_member_id,
      requested.away_member_id
    FROM requested
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*)
    INTO v_inserted_count
    FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.insert_playoff_matchups_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_matchups jsonb DEFAULT '[]'::jsonb,
  p_tiebreakers jsonb DEFAULT '[]'::jsonb,
  p_skip_if_matchup_types jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted_count int := 0;
  v_tiebreaker record;
  v_existing_challenge public.rps_challenges%ROWTYPE;
BEGIN
  IF p_matchups IS NULL OR jsonb_typeof(p_matchups) <> 'array' THEN
    RAISE EXCEPTION 'p_matchups must be a JSON array.';
  END IF;

  IF p_tiebreakers IS NULL OR jsonb_typeof(p_tiebreakers) <> 'array' THEN
    RAISE EXCEPTION 'p_tiebreakers must be a JSON array.';
  END IF;

  IF p_skip_if_matchup_types IS NULL OR jsonb_typeof(p_skip_if_matchup_types) <> 'array' THEN
    RAISE EXCEPTION 'p_skip_if_matchup_types must be a JSON array.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('playoff-matchups'), hashtext(p_league_season_id::text));

  PERFORM 1
    FROM public.league_seasons AS season
   WHERE season.id = p_league_season_id
     AND season.league_id = p_league_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current league season not found for playoff generation.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.matchups AS matchup
     WHERE matchup.league_season_id = p_league_season_id
       AND matchup.matchup_type::text IN (
         SELECT value
           FROM jsonb_array_elements_text(p_skip_if_matchup_types)
       )
  ) THEN
    RETURN jsonb_build_object('inserted', 0, 'skipped', true);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     WHERE requested.league_id IS DISTINCT FROM p_league_id
        OR requested.league_season_id IS DISTINCT FROM p_league_season_id
        OR requested.week_number IS NULL
        OR requested.week_number < 1
        OR requested.matchup_type NOT IN ('playoff_quarterfinal', 'playoff_semifinal', 'playoff_final')
        OR requested.home_member_id IS NULL
        OR requested.away_member_id IS NULL
        OR requested.home_member_id = requested.away_member_id
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.home_member_id
             AND member.league_id = p_league_id
        )
        OR NOT EXISTS (
          SELECT 1
            FROM public.league_members AS member
           WHERE member.id = requested.away_member_id
             AND member.league_id = p_league_id
        )
  ) THEN
    RAISE EXCEPTION 'p_matchups contains invalid playoff rows.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
     GROUP BY
        requested.league_id,
        requested.league_season_id,
        requested.week_number,
        requested.matchup_type,
        LEAST(requested.home_member_id::text, requested.away_member_id::text),
        GREATEST(requested.home_member_id::text, requested.away_member_id::text)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_matchups contains duplicate playoff pairings.';
  END IF;

  FOR v_tiebreaker IN
    SELECT *
      FROM jsonb_to_recordset(p_tiebreakers) AS requested(
        league_id uuid,
        league_season_id uuid,
        member_a_id uuid,
        member_b_id uuid,
        winner_member_id uuid
      )
  LOOP
    IF v_tiebreaker.league_id IS DISTINCT FROM p_league_id
      OR v_tiebreaker.league_season_id IS DISTINCT FROM p_league_season_id
      OR v_tiebreaker.member_a_id IS NULL
      OR v_tiebreaker.member_b_id IS NULL
      OR v_tiebreaker.member_a_id = v_tiebreaker.member_b_id
      OR v_tiebreaker.winner_member_id NOT IN (v_tiebreaker.member_a_id, v_tiebreaker.member_b_id)
      OR NOT EXISTS (
        SELECT 1
          FROM public.league_members AS member
         WHERE member.id IN (v_tiebreaker.member_a_id, v_tiebreaker.member_b_id, v_tiebreaker.winner_member_id)
           AND member.league_id = p_league_id
        GROUP BY member.league_id
        HAVING count(*) = 3
      )
    THEN
      RAISE EXCEPTION 'p_tiebreakers contains invalid rows.';
    END IF;

    SELECT *
      INTO v_existing_challenge
      FROM public.rps_challenges AS challenge
     WHERE challenge.league_id = p_league_id
       AND challenge.league_season_id = p_league_season_id
       AND challenge.context = 'standings_playoff_tiebreaker'
       AND LEAST(challenge.member_a_id, challenge.member_b_id) = LEAST(v_tiebreaker.member_a_id, v_tiebreaker.member_b_id)
       AND GREATEST(challenge.member_a_id, challenge.member_b_id) = GREATEST(v_tiebreaker.member_a_id, v_tiebreaker.member_b_id)
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.rps_challenges
         SET winner_member_id = v_tiebreaker.winner_member_id,
             member_a_choice = NULL,
             member_b_choice = NULL,
             status = 'completed'::public.rps_status,
             resolved_at = now()
       WHERE id = v_existing_challenge.id;
    ELSE
      INSERT INTO public.rps_challenges (
        league_id,
        league_season_id,
        member_a_id,
        member_b_id,
        winner_member_id,
        status,
        context,
        resolved_at
      )
      VALUES (
        p_league_id,
        p_league_season_id,
        v_tiebreaker.member_a_id,
        v_tiebreaker.member_b_id,
        v_tiebreaker.winner_member_id,
        'completed'::public.rps_status,
        'standings_playoff_tiebreaker',
        now()
      );
    END IF;
  END LOOP;

  WITH requested AS (
    SELECT *
      FROM jsonb_to_recordset(p_matchups) AS requested(
        league_id uuid,
        league_season_id uuid,
        week_number int,
        matchup_type text,
        home_member_id uuid,
        away_member_id uuid
      )
  ),
  inserted AS (
    INSERT INTO public.matchups (
      league_id,
      league_season_id,
      week_number,
      matchup_type,
      home_member_id,
      away_member_id
    )
    SELECT
      requested.league_id,
      requested.league_season_id,
      requested.week_number,
      requested.matchup_type::public.matchup_type,
      requested.home_member_id,
      requested.away_member_id
    FROM requested
    ON CONFLICT (league_id, league_season_id, week_number, home_member_id, away_member_id)
    DO NOTHING
    RETURNING 1
  )
  SELECT count(*)
    INTO v_inserted_count
    FROM inserted;

  RETURN jsonb_build_object('inserted', v_inserted_count, 'skipped', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  status text,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 0), 200);
  v_trade record;
  v_error_code text;
  v_error_message text;
BEGIN
  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      v_error_code := SQLSTATE;
      v_error_message := SQLERRM;

      IF v_error_code NOT IN ('40001', '40P01', '57014', '53300', '08000', '08003', '08006') THEN
        BEGIN
          PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

          RETURN QUERY
          SELECT
            v_trade.id,
            v_trade.proposer_member_id,
            v_trade.recipient_member_id,
            'expired_terminal_failure'::text,
            v_error_code,
            v_error_message;
        EXCEPTION WHEN OTHERS THEN
          RETURN QUERY
          SELECT
            v_trade.id,
            v_trade.proposer_member_id,
            v_trade.recipient_member_id,
            'failed_retryable'::text,
            SQLSTATE::text,
            SQLERRM::text;
        END;
      ELSE
        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
      END IF;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.close_expired_auction_nominations_atomic(
  p_limit int DEFAULT 100
)
RETURNS TABLE (
  nomination_id uuid,
  closed boolean,
  error_code text,
  error_message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 100), 0), 500);
  v_nomination record;
  v_closed boolean;
BEGIN
  FOR v_nomination IN
    SELECT nomination.id
      FROM public.nominations AS nomination
      JOIN public.drafts AS draft
        ON draft.id = nomination.draft_id
     WHERE nomination.status = 'open'::public.nomination_status
       AND nomination.countdown_expires_at < now()
       AND draft.status = 'in_progress'::public.draft_status
     ORDER BY nomination.countdown_expires_at, nomination.nominated_at, nomination.id
     LIMIT v_limit
     FOR UPDATE OF nomination SKIP LOCKED
  LOOP
    BEGIN
      SELECT public.close_auction_nomination_atomic(v_nomination.id)
        INTO v_closed;

      RETURN QUERY
      SELECT
        v_nomination.id,
        COALESCE(v_closed, false),
        NULL::text,
        NULL::text;
    EXCEPTION WHEN OTHERS THEN
      RETURN QUERY
      SELECT
        v_nomination.id,
        false,
        SQLSTATE::text,
        SQLERRM::text;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_regular_season_matchups_atomic(uuid, uuid, boolean, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_regular_season_matchups_atomic(uuid, uuid, boolean, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.replace_regular_season_matchups_atomic(uuid, uuid, boolean, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_regular_season_matchups_atomic(uuid, uuid, boolean, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.insert_playoff_matchups_atomic(uuid, uuid, jsonb, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM anon;
REVOKE ALL ON FUNCTION public.process_due_accepted_trades_atomic(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_due_accepted_trades_atomic(int) TO service_role;

REVOKE ALL ON FUNCTION public.close_expired_auction_nominations_atomic(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_expired_auction_nominations_atomic(int) FROM anon;
REVOKE ALL ON FUNCTION public.close_expired_auction_nominations_atomic(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.close_expired_auction_nominations_atomic(int) TO service_role;
