-- Canonical SQL source for public.process_due_accepted_trades_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.process_due_accepted_trades_atomic(
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  trade_id uuid,
  proposer_member_id uuid,
  recipient_member_id uuid,
  participant_member_ids uuid[],
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
  v_trade_ids uuid[];
  v_asset record;
  v_error_code text;
  v_error_message text;
BEGIN
  -- A batch retains league rows after each completion. Take every selected
  -- team's and player's locks before the first completion takes those rows.
  SELECT COALESCE(array_agg(due.id), ARRAY[]::uuid[]) INTO v_trade_ids
  FROM (
    SELECT trade.id
    FROM public.trades AS trade
    JOIN public.league_seasons AS season
      ON season.id = trade.league_season_id
    JOIN public.leagues AS league
      ON league.id = trade.league_id
    WHERE trade.status = 'accepted'::public.trade_status
      AND trade.veto_window_expires_at <= now()
      AND season.is_current = true
      AND league.status IN ('active'::public.league_status, 'playoffs'::public.league_status, 'offseason'::public.league_status)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
    LIMIT v_limit
    FOR UPDATE OF trade SKIP LOCKED
  ) AS due;

  FOR v_asset IN
    SELECT DISTINCT trade.league_id, member.member_id
      FROM public.trades AS trade
      CROSS JOIN LATERAL (
        SELECT trade.proposer_member_id AS member_id
        UNION SELECT trade.recipient_member_id
        UNION SELECT participant.member_id FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
      ) AS member
     WHERE trade.id = ANY(v_trade_ids)
     ORDER BY trade.league_id, member.member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.member_id::text));
  END LOOP;

  FOR v_asset IN
    SELECT DISTINCT trade.league_id, item.player_id
      FROM public.trades AS trade
      JOIN public.trade_items AS item ON item.trade_id = trade.id
     WHERE trade.id = ANY(v_trade_ids) AND item.player_id IS NOT NULL
     ORDER BY trade.league_id, item.player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(v_asset.league_id::text), hashtext(v_asset.player_id::text));
  END LOOP;

  FOR v_trade IN
    SELECT
      trade.id,
      trade.proposer_member_id,
      trade.recipient_member_id,
      ARRAY(
        SELECT participant.member_id
          FROM public.trade_participants AS participant
         WHERE participant.trade_id = trade.id
         ORDER BY participant.sort_order, participant.member_id
      ) AS participant_member_ids
    FROM public.trades AS trade
    WHERE trade.id = ANY(v_trade_ids)
    ORDER BY trade.veto_window_expires_at, trade.proposed_at, trade.id
  LOOP
    BEGIN
      PERFORM public.complete_accepted_trade_atomic(v_trade.id);

      RETURN QUERY
      SELECT
        v_trade.id,
        v_trade.proposer_member_id,
        v_trade.recipient_member_id,
        CASE
          WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
          ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
        END,
        'completed'::text,
        NULL::text,
        NULL::text;
    EXCEPTION
      WHEN SQLSTATE 'PT001' THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        PERFORM public.expire_trade_completion_failure_atomic(v_trade.id, v_error_message);

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'expired_terminal_failure'::text,
          v_error_code,
          v_error_message;
      WHEN serialization_failure OR deadlock_detected OR lock_not_available THEN
        v_error_code := SQLSTATE;
        v_error_message := SQLERRM;

        RETURN QUERY
        SELECT
          v_trade.id,
          v_trade.proposer_member_id,
          v_trade.recipient_member_id,
          CASE
            WHEN cardinality(v_trade.participant_member_ids) > 0 THEN v_trade.participant_member_ids
            ELSE ARRAY[v_trade.proposer_member_id, v_trade.recipient_member_id]
          END,
          'failed_retryable'::text,
          v_error_code,
          v_error_message;
    END;
  END LOOP;
END;
$$;
