-- ============================================================
-- Migration: Revoke broad client mutation grants
--
-- The launch-readiness security audit found that anon/authenticated
-- still held table-level INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
-- grants on most public tables, even after later migrations moved core
-- gameplay writes to SECURITY DEFINER RPCs and backend service-role paths.
--
-- RLS policies blocked many of those writes, but the table grants were
-- still unnecessary attack surface and contradicted the documented posture
-- in the prior lockdown migrations. This migration makes the grant layer
-- match the app's current write model:
--
--   - End-user table writes are limited to profiles and team-name edits.
--   - League, draft, roster, trade, waiver, lineup, score, sports-data,
--     and audit-log mutations flow through RPCs/backend/service_role.
--   - Reads remain unchanged.
--
-- Idempotent: repeated REVOKE/GRANT calls are safe.
-- ============================================================

-- 1. Remove broad table-level mutation privileges from PostgREST end-user
-- roles. SELECT grants and RLS read policies are intentionally untouched.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

-- 2. Remove prior column-level direct-write grants that are now replaced by
-- RPCs/backend routes. REVOKE is safe if the grant is already absent.
REVOKE UPDATE (
  scoring_settings,
  roster_size,
  ir_slots,
  taxi_slots,
  auction_budget,
  playoff_start_week,
  trade_deadline
) ON public.leagues FROM authenticated;

-- 3. Re-grant the intentional client-side write surface.
--
-- Profiles: sign-up creates the caller's profile row; profile/push-token
-- updates are still direct client writes protected by profiles_update RLS.
GRANT INSERT (
  id,
  username,
  display_name
) ON public.profiles TO authenticated;

GRANT UPDATE (
  display_name,
  avatar_url,
  timezone,
  updated_at,
  push_token
) ON public.profiles TO authenticated;

-- League members: the app lets a manager rename their own team. Keep this
-- to team_name only; role, user_id, league_id, and joined_at must never be
-- mutable through the client grant layer.
GRANT UPDATE (team_name) ON public.league_members TO authenticated;

-- 4. Defense in depth for trusted server callers. Backend/Edge secret keys
-- run as service_role and already bypass RLS; explicit grants document the
-- intended server write path.
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  TO service_role;

-- 5. Do not hand future public tables broad mutation grants to client roles.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES
  FROM anon, authenticated;

-- 6. Trigger functions should not be directly executable as RPCs by client
-- roles. Trigger execution itself is unaffected by EXECUTE revocation.
REVOKE ALL ON FUNCTION public.set_weekly_lineup_week_number_from_date()
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.profiles IS
  'User profile rows. Authenticated clients may INSERT their own profile '
  'and UPDATE only display/avatar/timezone/updated_at/push_token columns '
  'under profiles_insert/profiles_update RLS. push_token SELECT remains '
  'column-revoked from client roles.';

COMMENT ON TABLE public.league_members IS
  'Per-league membership rows. Authenticated clients may UPDATE only their '
  'own team_name under league_members_update RLS. Membership creation, role '
  'changes, league_id/user_id changes, and lifecycle writes must flow through '
  'SECURITY DEFINER RPCs or the backend service-role client.';
