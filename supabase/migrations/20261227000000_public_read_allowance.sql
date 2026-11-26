BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.public_admit_read(p_client_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1s' SET statement_timeout='2s' AS $$
DECLARE
  used integer;
  read_at timestamptz:=clock_timestamp();
  current_minute timestamptz:=date_trunc('minute',read_at);
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status',400); END IF;
  INSERT INTO private.public_api_buckets(bucket_key,minute,reads) VALUES(p_client_key,current_minute,1)
    ON CONFLICT(bucket_key,minute) DO UPDATE SET reads=private.public_api_buckets.reads+1
    WHERE private.public_api_buckets.reads<240 RETURNING reads INTO used;
  IF used IS NULL THEN
    RETURN jsonb_build_object('status',429,'retryAfter',greatest(1,ceil(extract(epoch FROM current_minute+interval '1 minute'-read_at))::integer));
  END IF;
  DELETE FROM private.public_api_buckets WHERE (bucket_key,minute) IN (
    SELECT bucket_key,minute FROM private.public_api_buckets WHERE minute<current_minute-interval '2 minutes'
    ORDER BY minute LIMIT 128 FOR UPDATE SKIP LOCKED
  );
  RETURN jsonb_build_object('status',200);
END;
$$;
REVOKE ALL ON FUNCTION public.public_admit_read(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.public_admit_read(text) TO service_role;

COMMIT;
