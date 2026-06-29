-- Trusted backend and Edge callers use Supabase secret/service-role keys.
-- They bypass RLS, but they still need ordinary SQL SELECT privileges for
-- PostgREST reads and read-before-write mutations.

GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;
