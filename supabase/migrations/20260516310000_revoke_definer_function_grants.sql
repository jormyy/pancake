-- ============================================================
-- Migration: Revoke default PUBLIC EXECUTE on four SECURITY
--            DEFINER functions; grant EXECUTE to service_role
--            only.
--
-- SECURITY FIX (Slice A — iter 29):
--   When a function is created without an explicit REVOKE,
--   PostgreSQL grants EXECUTE to the PUBLIC role by default.
--   For SECURITY DEFINER functions this is dangerous: any
--   client able to reach the database (anon, authenticated,
--   service_role, postgres) inherits the privileges of the
--   function owner when the function runs.
--
--   Four SECURITY DEFINER functions in the public schema were
--   created without that explicit REVOKE and currently retain
--   the default PUBLIC EXECUTE grant. Each one is reachable via
--   PostgREST RPC (e.g. POST /rest/v1/rpc/<name>) from the anon
--   and authenticated roles. The four functions and their
--   blast radius:
--
--     1. public.invoke_edge_function(text, jsonb)
--        Defined in migrations
--          20260327000018_cron_jobs.sql,
--          20260327000019_cron_fn_credentials.sql,
--          20260328000001_vault_credentials.sql.
--        Triggers ANY Supabase Edge Function (sync-players,
--        process-waivers, sync-stats, etc.) using the
--        service_role JWT read from current_setting(
--        'app.service_role_key'). An attacker who can call
--        rpc/invoke_edge_function can stampede the entire
--        sync pipeline, exhaust pg_net workers, exhaust Edge
--        Function quota, and indirectly impersonate the
--        service role against the rest of the API surface.
--
--     2. public.merge_players(uuid, uuid)
--        Defined in migrations
--          20260403000003_dedup_players.sql,
--          20260422000002_security_fixes.sql.
--        Destructively merges two players: DELETEs the loser
--        from `players` and rewrites foreign keys across
--        roster_players, weekly_lineups, player_projections,
--        nominations, waiver_claims, waiver_wire_log,
--        trade_items, roster_transactions, and
--        player_game_stats. A single anon RPC call can
--        permanently corrupt rosters, lineups, projections,
--        and historical stats for two arbitrary players.
--
--     3. public.merge_duplicate_players()
--        Defined in migrations
--          20260403000003_dedup_players.sql,
--          20260403000004_dedup_players_v2.sql,
--          20260422000002_security_fixes.sql.
--        Iterates merge_players across the entire players
--        table — one anon RPC call can collapse the catalog.
--
--     4. public.count_final_games_missing_stats(int)
--        Defined in migrations
--          20260327000020_rpc_missing_stats.sql,
--          20260422000002_security_fixes.sql.
--        Information-disclosure aggregate over nba_games and
--        player_game_stats. Low impact (read-only count) but
--        still bypasses RLS on those tables via DEFINER, so
--        it should match the lockdown pattern of every other
--        DEFINER function in the repo.
--
--   Every other SECURITY DEFINER function added in this repo
--   follows the standard pattern:
--
--     REVOKE ALL ON FUNCTION public.<name>(<args>)
--       FROM PUBLIC, anon, authenticated;
--     GRANT EXECUTE ON FUNCTION public.<name>(<args>)
--       TO service_role;
--
--   These four missed that step. This migration applies the
--   same pattern to close the gap.
--
-- Backend impact:
--   • invoke_edge_function — called from pg_cron jobs running
--     as the postgres / cron owner (see
--     20260327000018_cron_jobs.sql), which is not constrained
--     by PUBLIC/anon/authenticated grants. Also invoked from
--     the backend service-role client, preserved by the
--     explicit service_role GRANT below.
--   • merge_players / merge_duplicate_players — admin-only
--     maintenance utilities invoked from one-off scripts or
--     the Supabase SQL editor (service_role / postgres).
--     Preserved via the service_role GRANT.
--   • count_final_games_missing_stats — backend reporting
--     queries run as service_role. Preserved via GRANT.
--
--   No frontend/authenticated path calls any of the four —
--   verified by grep for the function names across the repo:
--   the only callers are pg_cron jobs, other SECURITY DEFINER
--   functions, and backend code using the service-role
--   client, all of which bypass these grants.
--
-- Idempotency:
--   REVOKE and GRANT are naturally idempotent. Re-running this
--   migration on an already-locked database is a no-op.
--
-- Rollback (NOT recommended — reintroduces the issue):
--   GRANT EXECUTE ON FUNCTION public.<name>(<args>) TO PUBLIC;
-- ============================================================


-- ────────────────────────────────────────────────────────────────────────
-- 1. invoke_edge_function(text, jsonb)
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.invoke_edge_function(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_edge_function(text, jsonb)
  TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 2. merge_players(uuid, uuid)
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.merge_players(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_players(uuid, uuid)
  TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 3. merge_duplicate_players()
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.merge_duplicate_players()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_players()
  TO service_role;


-- ────────────────────────────────────────────────────────────────────────
-- 4. count_final_games_missing_stats(int)
-- ────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.count_final_games_missing_stats(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_final_games_missing_stats(int)
  TO service_role;
