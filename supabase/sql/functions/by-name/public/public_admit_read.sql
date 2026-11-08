CREATE OR REPLACE FUNCTION public.public_admit_read(p_client_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='1s' SET statement_timeout='2s' AS $$
DECLARE
  used integer;
  current_minute timestamptz:=date_trunc('minute',clock_timestamp());
BEGIN
  IF p_client_key IS NULL OR p_client_key !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status',400); END IF;
  INSERT INTO private.public_api_buckets(bucket_key,minute,reads) VALUES(p_client_key,current_minute,1)
    ON CONFLICT(bucket_key,minute) DO UPDATE SET reads=private.public_api_buckets.reads+1
    WHERE private.public_api_buckets.reads<60 RETURNING reads INTO used;
  IF used IS NULL THEN RETURN jsonb_build_object('status',429,'retryAfter',60); END IF;
  DELETE FROM private.public_api_buckets WHERE (bucket_key,minute) IN (
    SELECT bucket_key,minute FROM private.public_api_buckets WHERE minute<current_minute-interval '2 minutes'
    ORDER BY minute LIMIT 128 FOR UPDATE SKIP LOCKED
  );
  RETURN jsonb_build_object('status',200);
END;
$$;
