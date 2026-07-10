-- Canonical SQL source for public.get_trade_page_refs.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_page_refs(
  p_member_id uuid,
  p_league_id uuid,
  p_limit int DEFAULT 40,
  p_cursor text DEFAULT NULL
)
RETURNS TABLE (trade_id uuid, cursor_token text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cursor jsonb;
  v_cursor_tier int;
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_limit int := LEAST(GREATEST(p_limit, 1), 100);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.league_members AS own_member
     WHERE own_member.id = p_member_id
       AND own_member.league_id = p_league_id
       AND own_member.user_id = (SELECT auth.uid())
  ) THEN
    RETURN;
  END IF;

  IF p_cursor IS NOT NULL THEN
    BEGIN
      v_cursor := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      v_cursor_tier := (v_cursor->>'tier')::int;
      v_cursor_at := (v_cursor->>'at')::timestamptz;
      v_cursor_id := (v_cursor->>'id')::uuid;
      IF v_cursor_tier NOT BETWEEN 1 AND 3 OR v_cursor_at IS NULL OR v_cursor_id IS NULL THEN
        RAISE EXCEPTION 'invalid cursor';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Trade page cursor is invalid.' USING ERRCODE = '22023';
    END;
  END IF;

  RETURN QUERY
  WITH observer_actions AS (
    SELECT trade.id, 2 AS tier, trade.proposed_at
      FROM public.trades AS trade
     WHERE trade.league_id = p_league_id
       AND trade.status = 'accepted'::public.trade_status
       AND trade.veto_window_expires_at > now()
       AND NOT EXISTS (
         SELECT 1
           FROM public.trade_participants AS participant
          WHERE participant.trade_id = trade.id
            AND participant.member_id = p_member_id
       )
       AND (
         v_cursor_tier IS NULL OR 2 < v_cursor_tier OR
         (v_cursor_tier = 2 AND (trade.proposed_at, trade.id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY trade.proposed_at DESC, trade.id DESC
     LIMIT v_limit
  ), participant_actions AS (
    SELECT trade.id, 3 AS tier, trade.proposed_at
      FROM public.trade_participants AS participant
      JOIN public.trades AS trade ON trade.id = participant.trade_id
     WHERE participant.league_id = p_league_id
       AND participant.member_id = p_member_id
       AND participant.accepted_at IS NULL
       AND trade.status = 'pending'::public.trade_status
       AND (
         v_cursor_tier IS NULL OR 3 < v_cursor_tier OR
         (v_cursor_tier = 3 AND (participant.proposed_at, participant.trade_id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY participant.proposed_at DESC, participant.trade_id DESC
     LIMIT v_limit
  ), participant_history AS (
    SELECT trade.id, 1 AS tier, trade.proposed_at
      FROM public.trade_participants AS participant
      JOIN public.trades AS trade ON trade.id = participant.trade_id
     WHERE participant.league_id = p_league_id
       AND participant.member_id = p_member_id
       AND NOT (trade.status = 'pending'::public.trade_status AND participant.accepted_at IS NULL)
       AND (
         v_cursor_tier IS NULL OR 1 < v_cursor_tier OR
         (v_cursor_tier = 1 AND (participant.proposed_at, participant.trade_id) < (v_cursor_at, v_cursor_id))
       )
     ORDER BY participant.proposed_at DESC, participant.trade_id DESC
     LIMIT v_limit
  ), page AS (
    SELECT * FROM observer_actions
    UNION ALL
    SELECT * FROM participant_actions
    UNION ALL
    SELECT * FROM participant_history
    ORDER BY tier DESC, proposed_at DESC, id DESC
    LIMIT v_limit
  )
  SELECT page.id,
    encode(convert_to(jsonb_build_object(
      'tier', page.tier,
      'at', page.proposed_at,
      'id', page.id
    )::text, 'UTF8'), 'base64')
    FROM page
   ORDER BY page.tier DESC, page.proposed_at DESC, page.id DESC;
END;
$$;
