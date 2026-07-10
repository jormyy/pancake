-- Undo remote schema dump grants that exposed league/user/gameplay tables to anon.
-- Authenticated reads remain governed by RLS; public anon reads are limited to
-- non-user NBA/player reference content.

SET lock_timeout = '5s';
SET statement_timeout = '2min';

REVOKE SELECT ON TABLE public.bids FROM anon;
REVOKE SELECT ON TABLE public.draft_audit_logs FROM anon;
REVOKE SELECT ON TABLE public.draft_budgets FROM anon;
REVOKE SELECT ON TABLE public.draft_orders FROM anon;
REVOKE SELECT ON TABLE public.draft_picks FROM anon;
REVOKE SELECT ON TABLE public.draft_room_members FROM anon;
REVOKE SELECT ON TABLE public.drafts FROM anon;
REVOKE SELECT ON TABLE public.faab_balances FROM anon;
REVOKE SELECT ON TABLE public.league_activity FROM anon;
REVOKE SELECT ON TABLE public.league_members FROM anon;
REVOKE SELECT ON TABLE public.league_seasons FROM anon;
REVOKE SELECT ON TABLE public.leagues FROM anon;
REVOKE SELECT ON TABLE public.lineup_optimizer_settings FROM anon;
REVOKE SELECT ON TABLE public.lineup_slot_templates FROM anon;
REVOKE SELECT ON TABLE public.live_poll_leases FROM anon;
REVOKE SELECT ON TABLE public.matchups FROM anon;
REVOKE SELECT ON TABLE public.nominations FROM anon;
REVOKE SELECT ON TABLE public.notification_preferences FROM anon;
REVOKE SELECT ON TABLE public.player_projections FROM anon;
REVOKE SELECT ON TABLE public.roster_players FROM anon;
REVOKE SELECT ON TABLE public.roster_transactions FROM anon;
REVOKE SELECT ON TABLE public.rps_challenges FROM anon;
REVOKE SELECT ON TABLE public.snake_draft_picks FROM anon;
REVOKE SELECT ON TABLE public.standings FROM anon;
REVOKE SELECT ON TABLE public.trade_block_items FROM anon;
REVOKE SELECT ON TABLE public.trade_items FROM anon;
REVOKE SELECT ON TABLE public.trade_vetos FROM anon;
REVOKE SELECT ON TABLE public.trades FROM anon;
REVOKE SELECT ON TABLE public.waiver_claims FROM anon;
REVOKE SELECT ON TABLE public.waiver_priorities FROM anon;
REVOKE SELECT ON TABLE public.waiver_wire_log FROM anon;
REVOKE SELECT ON TABLE public.weekly_add_counts FROM anon;
REVOKE SELECT ON TABLE public.weekly_lineups FROM anon;

RESET statement_timeout;
RESET lock_timeout;
