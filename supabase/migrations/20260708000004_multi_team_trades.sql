-- F13 multi-team trades: explicit participants, routed assets, and atomic participant acceptance.

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS is_multi_team boolean NOT NULL DEFAULT false;

ALTER TABLE public.trade_items
  ADD COLUMN IF NOT EXISTS from_member_id uuid REFERENCES public.league_members(id),
  ADD COLUMN IF NOT EXISTS to_member_id uuid REFERENCES public.league_members(id),
  ADD COLUMN IF NOT EXISTS faab_amount int NOT NULL DEFAULT 0;

UPDATE public.trade_items AS item
   SET from_member_id = COALESCE(item.from_member_id, CASE WHEN item.side = 'proposer'::public.trade_side THEN trade.proposer_member_id ELSE trade.recipient_member_id END),
       to_member_id = COALESCE(item.to_member_id, CASE WHEN item.side = 'proposer'::public.trade_side THEN trade.recipient_member_id ELSE trade.proposer_member_id END)
  FROM public.trades AS trade
 WHERE trade.id = item.trade_id;

ALTER TABLE public.trade_items
  DROP CONSTRAINT IF EXISTS trade_items_check,
  DROP CONSTRAINT IF EXISTS trade_items_one_asset_check,
  DROP CONSTRAINT IF EXISTS trade_items_route_distinct_check,
  DROP CONSTRAINT IF EXISTS trade_items_faab_nonnegative_check;

ALTER TABLE public.trade_items
  ADD CONSTRAINT trade_items_one_asset_check CHECK (
    ((player_id IS NOT NULL)::int + (pick_id IS NOT NULL)::int + (faab_amount > 0)::int) = 1
  ),
  ADD CONSTRAINT trade_items_route_distinct_check CHECK (
    from_member_id IS NULL OR to_member_id IS NULL OR from_member_id <> to_member_id
  ),
  ADD CONSTRAINT trade_items_faab_nonnegative_check CHECK (faab_amount >= 0);

CREATE INDEX IF NOT EXISTS idx_trade_items_from_member ON public.trade_items(from_member_id) WHERE from_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trade_items_to_member ON public.trade_items(to_member_id) WHERE to_member_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.trade_participants (
  trade_id uuid NOT NULL REFERENCES public.trades(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.league_members(id),
  sort_order int NOT NULL DEFAULT 0,
  is_initiator boolean NOT NULL DEFAULT false,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trade_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_participants_member ON public.trade_participants(member_id, trade_id);

INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT trade.id, trade.proposer_member_id, 0, true, trade.proposed_at
  FROM public.trades AS trade
ON CONFLICT (trade_id, member_id) DO NOTHING;

INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT trade.id,
       trade.recipient_member_id,
       1,
       false,
       CASE WHEN trade.status IN ('accepted'::public.trade_status, 'completed'::public.trade_status, 'vetoed'::public.trade_status) THEN trade.accepted_at ELSE NULL END
  FROM public.trades AS trade
ON CONFLICT (trade_id, member_id) DO NOTHING;

ALTER TABLE public.trade_participants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trade_participants_select_parties_or_accepted" ON public.trade_participants;
CREATE POLICY "trade_participants_select_parties_or_accepted" ON public.trade_participants
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.trades AS trade
       WHERE trade.id = trade_participants.trade_id
         AND trade.league_id IN (SELECT private.my_league_ids())
         AND (
           trade.status = 'accepted'::public.trade_status
           OR trade.proposer_member_id IN (SELECT private.my_member_ids())
           OR trade.recipient_member_id IN (SELECT private.my_member_ids())
           OR trade_participants.member_id IN (SELECT private.my_member_ids())
         )
    )
  );

DROP POLICY IF EXISTS "trades_select_parties_or_accepted" ON public.trades;
CREATE POLICY "trades_select_parties_or_accepted" ON public.trades
  FOR SELECT TO authenticated
  USING (
    league_id IN (SELECT private.my_league_ids())
    AND (
      status = 'accepted'::public.trade_status
      OR proposer_member_id IN (SELECT private.my_member_ids())
      OR recipient_member_id IN (SELECT private.my_member_ids())
      OR EXISTS (
        SELECT 1
          FROM public.trade_participants AS participant
         WHERE participant.trade_id = trades.id
           AND participant.member_id IN (SELECT private.my_member_ids())
      )
    )
  );

DROP POLICY IF EXISTS "trade_items_select_parties_or_accepted" ON public.trade_items;
CREATE POLICY "trade_items_select_parties_or_accepted" ON public.trade_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.trades AS trade
      WHERE trade.id = trade_items.trade_id
        AND trade.league_id IN (SELECT private.my_league_ids())
        AND (
          trade.status = 'accepted'::public.trade_status
          OR trade.proposer_member_id IN (SELECT private.my_member_ids())
          OR trade.recipient_member_id IN (SELECT private.my_member_ids())
          OR EXISTS (
            SELECT 1
              FROM public.trade_participants AS participant
             WHERE participant.trade_id = trade.id
               AND participant.member_id IN (SELECT private.my_member_ids())
          )
        )
    )
  );


CREATE OR REPLACE FUNCTION public.propose_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_recipient_member_id uuid,
  p_offer_player_ids uuid[],
  p_request_player_ids uuid[],
  p_offer_pick_ids uuid[],
  p_request_pick_ids uuid[],
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_offer_faab_amount int DEFAULT 0,
  p_request_faab_amount int DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_recipient_member_id,
    p_offer_player_ids,
    p_request_player_ids,
    p_offer_pick_ids,
    p_request_pick_ids,
    p_notes,
    p_expires_at,
    p_offer_faab_amount,
    p_request_faab_amount,
    NULL,
    NULL,
    NULL,
    1
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.propose_multi_team_trade_atomic(
  p_league_id uuid,
  p_league_season_id uuid,
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[],
  p_items jsonb,
  p_notes text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN private.create_multi_team_trade_offer(
    p_league_id,
    p_league_season_id,
    p_proposer_member_id,
    p_participant_member_ids,
    p_items,
    p_notes,
    p_expires_at
  );
END;
$$;


CREATE OR REPLACE FUNCTION public.reject_trade_atomic(
  p_trade_id uuid,
  p_member_id uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trade trades%ROWTYPE;
BEGIN
  SELECT *
    INTO v_trade
    FROM trades
   WHERE id = p_trade_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trade not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_trade.status <> 'pending'::public.trade_status THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(v_trade.is_multi_team, false) THEN
    IF v_trade.proposer_member_id = p_member_id OR NOT EXISTS (
      SELECT 1
        FROM trade_participants AS participant
       WHERE participant.trade_id = p_trade_id
         AND participant.member_id = p_member_id
         AND participant.accepted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Only a non-proposer trade participant can reject this trade.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_trade.recipient_member_id <> p_member_id THEN
    RAISE EXCEPTION 'Only the trade recipient can reject this trade.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.league_members AS member
   WHERE member.id = p_member_id
     AND member.user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to act for this member.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.trades
     SET status = 'rejected'::public.trade_status
   WHERE id = p_trade_id
     AND status = 'pending'::public.trade_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This trade is no longer pending.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'proposerMemberId', v_trade.proposer_member_id,
    'recipientMemberId', v_trade.recipient_member_id
  );
END;
$$;


REVOKE ALL ON FUNCTION public.propose_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_multi_team_trade_atomic(uuid, uuid, uuid, uuid[], jsonb, text, timestamptz) TO service_role;
