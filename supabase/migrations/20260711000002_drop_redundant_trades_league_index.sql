-- Drops idx_trades_league, which is a strict prefix of idx_trades_league_status.
--
-- Both were created in 20260226000002_indexes.sql. Postgres can serve any
-- league_id-only lookup from the (league_id, status) composite, so the
-- single-column index only adds write amplification on every trade insert and
-- status transition. Same reasoning as 20260709100030, which dropped the
-- dominated trade feed indexes.

DROP INDEX IF EXISTS public.idx_trades_league;
