-- Internal scheduling records have no client policies; existing grants remain unchanged.
ALTER TABLE public.cron_dispatch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_invocations ENABLE ROW LEVEL SECURITY;

-- Clarify existing rules and messages without changing dispatch or waiver gates.
CREATE OR REPLACE FUNCTION public.edit_waiver_claim_atomic(
  p_claim_id uuid,
  p_member_id uuid,
  p_user_id uuid,
  p_drop_player_id uuid DEFAULT NULL,
  p_bid_amount int DEFAULT 0,
  p_claim_order int DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claim waiver_claims%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_bid_amount int := COALESCE(p_bid_amount, 0);
  v_balance int;
  v_drop_failure text;
BEGIN
  IF v_bid_amount < 0 THEN
    RAISE EXCEPTION 'FAAB bid must be a non-negative integer.'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_claim
    FROM waiver_claims
   WHERE id = p_claim_id
     AND member_id = p_member_id
     AND status = 'pending'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending waiver claim not found.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_claim.league_id
     AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_claim.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  -- Like create_waiver_claim_atomic, edits require eligible league/season state
  -- and add capacity. An uncleared waiver entry stays editable until processing,
  -- even after clears_at; a processed entry no longer accepts edits.
  IF v_league.status NOT IN ('active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Waiver claims require an active, playoff, or offseason league.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons
   WHERE id = v_claim.league_season_id
     AND is_current = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active season found.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, p_member_id);

  PERFORM 1
    FROM waiver_wire_log
   WHERE league_id = v_claim.league_id
     AND league_season_id = v_claim.league_season_id
     AND player_id = v_claim.player_id
     AND cleared_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This player is no longer on waivers.'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_drop_player_id IS NOT NULL AND p_drop_player_id = v_claim.player_id THEN
    RAISE EXCEPTION 'You cannot drop the player you are claiming.'
      USING ERRCODE = '22023';
  END IF;

  IF v_league.waiver_mode = 'rolling' THEN
    v_bid_amount := 0;
  ELSE
    v_balance := private.ensure_faab_balance(v_claim.league_id, v_claim.league_season_id, p_member_id);
    IF v_bid_amount > v_balance THEN
      RAISE EXCEPTION 'FAAB bid exceeds your available balance.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_drop_player_id IS NOT NULL THEN
    SELECT validation.failure_reason
      INTO v_drop_failure
      FROM private.validate_waiver_claim_drop_player(
        v_claim.league_id,
        v_claim.league_season_id,
        p_member_id,
        p_drop_player_id
      ) AS validation;

    IF v_drop_failure IS NOT NULL THEN
      RAISE EXCEPTION '%', v_drop_failure
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE waiver_claims
     SET drop_player_id = p_drop_player_id,
         bid_amount = v_bid_amount,
         claim_order = COALESCE(p_claim_order, claim_order),
         submitted_at = now()
   WHERE id = p_claim_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  -- Direct calls later in the week can catch up, once per ISO week.
  -- The installed cron only calls this on Mondays; it cannot retry on Tuesday.
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM public.invoke_edge_function('sync-rankings', '{"view":"POINT_5"}'::jsonb);
END;
$$;

