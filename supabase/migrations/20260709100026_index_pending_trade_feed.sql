CREATE INDEX IF NOT EXISTS idx_trade_participants_pending_feed
  ON public.trade_participants (member_id, proposed_at DESC, trade_id DESC)
  WHERE accepted_at IS NULL;
