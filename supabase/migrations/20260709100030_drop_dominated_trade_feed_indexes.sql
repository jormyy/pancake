SET lock_timeout = '5s';
SET statement_timeout = '2min';

DROP INDEX IF EXISTS public.idx_trades_league_proposer_recent;
DROP INDEX IF EXISTS public.idx_trades_league_recipient_recent;

RESET statement_timeout;
RESET lock_timeout;
