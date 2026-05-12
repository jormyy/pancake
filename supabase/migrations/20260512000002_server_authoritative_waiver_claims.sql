-- Move waiver claim submission/cancellation behind the Fastify backend.
--
-- Finding:
-- - P1-23: clients could forge waiver claim priority/process/status fields
--   because direct INSERT/UPDATE policies existed on waiver_claims.

DROP POLICY IF EXISTS "waiver_claims_insert" ON waiver_claims;
DROP POLICY IF EXISTS "waiver_claims_update" ON waiver_claims;

-- Clients keep SELECT access for their league waiver history. All writes now
-- use the backend service-role path, which derives priority, process date,
-- active season, and legal state transitions server-side.
