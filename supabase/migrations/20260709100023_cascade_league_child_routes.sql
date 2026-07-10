SET lock_timeout = '5s';
SET statement_timeout = '2min';

ALTER TABLE public.trade_items
  DROP CONSTRAINT IF EXISTS trade_items_league_id_fkey,
  ADD CONSTRAINT trade_items_league_id_fkey
    FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.trade_participants
  DROP CONSTRAINT IF EXISTS trade_participants_league_id_fkey,
  ADD CONSTRAINT trade_participants_league_id_fkey
    FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.trade_vetos
  DROP CONSTRAINT IF EXISTS trade_vetos_league_id_fkey,
  ADD CONSTRAINT trade_vetos_league_id_fkey
    FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.bids
  DROP CONSTRAINT IF EXISTS bids_league_id_fkey,
  ADD CONSTRAINT bids_league_id_fkey
    FOREIGN KEY (league_id) REFERENCES public.leagues(id) ON DELETE CASCADE NOT VALID;

RESET statement_timeout;
RESET lock_timeout;
