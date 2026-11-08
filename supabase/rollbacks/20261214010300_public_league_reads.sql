BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DROP FUNCTION IF EXISTS public.public_read_v2(uuid,text,jsonb,text);
DROP TABLE IF EXISTS private.public_api_buckets;
NOTIFY pgrst,'reload schema';
COMMIT;
