SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE INDEX IF NOT EXISTS idx_trade_participants_pending_feed
  ON public.trade_participants (member_id, proposed_at DESC, trade_id DESC)
  WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trades_veto_feed
  ON public.trades (league_id, proposed_at DESC, id DESC)
  INCLUDE (veto_window_expires_at)
  WHERE status = 'accepted'::public.trade_status;

ALTER TABLE public.trade_items
  VALIDATE CONSTRAINT trade_items_league_id_fkey,
  VALIDATE CONSTRAINT trade_items_from_participant_fkey,
  VALIDATE CONSTRAINT trade_items_to_participant_fkey;

ALTER TABLE public.trade_participants
  VALIDATE CONSTRAINT trade_participants_league_id_fkey;

ALTER TABLE public.trade_vetos
  VALIDATE CONSTRAINT trade_vetos_league_id_fkey;

ALTER TABLE public.bids
  VALIDATE CONSTRAINT bids_league_id_fkey;

RESET statement_timeout;
RESET lock_timeout;
