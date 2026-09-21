-- get_member_transaction_state is callable by members only.
--
-- Production's default privileges for the postgres role grant EXECUTE on
-- every new public function to anon. Migration 20260827000010 dropped and
-- recreated public.get_member_transaction_state, which picked that grant up
-- even though the migration revoked PUBLIC. The function refuses callers
-- without auth.uid(), so nothing was exposed; this records the revocation
-- that production received by hand and makes every environment converge on
-- the catalog: postgres, authenticated, and service_role only.

REVOKE EXECUTE ON FUNCTION public.get_member_transaction_state(uuid, uuid) FROM anon;
