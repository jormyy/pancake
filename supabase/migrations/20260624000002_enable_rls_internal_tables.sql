-- Internal bookkeeping tables should still have RLS enabled so schema
-- linting and future grant changes cannot accidentally expose them.
-- There are no anon/authenticated policies: server/service-role and
-- SECURITY DEFINER paths are the only intended writers/readers.

ALTER TABLE public.backfill_game_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_drop_reservations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.backfill_game_attempts IS
  'Internal sports-data backfill attempt ledger. No client RLS policies; '
  'written by backend/Edge service-role backfill code only.';

COMMENT ON TABLE public.trade_drop_reservations IS
  'Internal trade-overflow reservation ledger. No client RLS policies; '
  'written inside SECURITY DEFINER trade RPCs and backend service-role paths only.';
