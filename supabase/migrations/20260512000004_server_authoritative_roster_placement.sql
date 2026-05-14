-- Move IR/taxi placement behind backend validation.
--
-- Finding:
-- - P1-20: IR/taxi eligibility, caps, and activation capacity were enforced
--   mainly in UI handlers, while direct client updates could bypass them.

DROP POLICY IF EXISTS "roster_players_update_own" ON roster_players;
REVOKE UPDATE (is_on_ir, is_on_taxi) ON roster_players FROM authenticated;

-- Clients still read rosters and may delete owned rows through the existing
-- drop-player flow. IR/taxi placement updates now use backend service-role
-- endpoints that validate owner, eligibility, slot caps, and activation space.
