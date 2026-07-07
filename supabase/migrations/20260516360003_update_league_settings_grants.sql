-- Grants for update_league_settings_atomic (split from 20260516360001 due to
-- Supabase CLI v2.75.0 prepared-statement restriction on multi-command migrations).
REVOKE ALL ON FUNCTION public.update_league_settings_atomic(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_league_settings_atomic(uuid, jsonb)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.update_league_settings_atomic(uuid, jsonb) IS
  'Commissioner-only league-settings writer. Validates leagues.status = ''setup'' '
  'for structural keys (scoring_settings, roster_size, ir_slots, taxi_slots, '
  'auction_budget); allows playoff_start_week and trade_deadline at any '
  'lifecycle stage. Replaces the direct PostgREST UPDATE in lib/league.ts '
  'updateLeague().';
