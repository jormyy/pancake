DELETE FROM public.trade_vetos AS later
USING public.trade_vetos AS earlier
WHERE later.trade_id = earlier.trade_id
  AND later.member_id = earlier.member_id
  AND later.id <> earlier.id
  AND (
    later.vetoed_at > earlier.vetoed_at
    OR (later.vetoed_at = earlier.vetoed_at AND later.id > earlier.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_vetos_trade_member
  ON public.trade_vetos(trade_id, member_id);

CREATE OR REPLACE FUNCTION public.veto_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_is_commissioner boolean;
  v_is_trade_party boolean;
  v_member_veto_count int;
  v_eligible_count int;
  v_threshold int;
  v_vetoed boolean;
  v_rows int;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'accepted'::trade_status THEN
    RAISE EXCEPTION 'This trade is not in its veto window.'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trade.veto_window_expires_at IS NULL OR v_trade.veto_window_expires_at <= now() THEN
    RAISE EXCEPTION 'The veto window has expired.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = p_member_id
     AND league_id = v_trade.league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League member not found.'
      USING ERRCODE = 'P0002';
  END IF;

  v_is_commissioner := v_member.role IN ('commissioner'::league_member_role, 'co_commissioner'::league_member_role);
  v_is_trade_party := v_member.id IN (v_trade.proposer_member_id, v_trade.recipient_member_id);

  IF v_is_trade_party AND NOT v_is_commissioner THEN
    RAISE EXCEPTION 'Trade parties cannot veto their own trade.'
      USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO trade_vetos (
      trade_id,
      member_id,
      veto_type
    )
    VALUES (
      p_trade_id,
      p_member_id,
      CASE WHEN v_is_commissioner THEN 'commissioner'::veto_type ELSE 'member'::veto_type END
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You have already vetoed this trade.'
      USING ERRCODE = '23505';
  END;

  SELECT count(*)
    INTO v_member_veto_count
    FROM trade_vetos
   WHERE trade_id = p_trade_id
     AND veto_type = 'member'::veto_type;

  SELECT count(*)
    INTO v_eligible_count
    FROM league_members
   WHERE league_id = v_trade.league_id
     AND id NOT IN (v_trade.proposer_member_id, v_trade.recipient_member_id);

  v_threshold := GREATEST(1, CEIL(COALESCE(v_eligible_count, 0)::numeric / 2)::int);
  v_vetoed := v_is_commissioner OR COALESCE(v_member_veto_count, 0) >= v_threshold;

  IF v_vetoed THEN
    UPDATE trades
       SET status = 'vetoed'::trade_status,
           vetoed_at = now()
     WHERE id = p_trade_id
       AND status = 'accepted'::trade_status;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Failed to veto trade atomically.'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'vetoed', v_vetoed,
    'vetoCount', COALESCE(v_member_veto_count, 0),
    'threshold', v_threshold,
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.veto_trade_atomic(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.veto_trade_atomic(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.veto_trade_atomic(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.veto_trade_atomic(uuid, uuid) TO service_role;
