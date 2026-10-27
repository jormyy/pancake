CREATE OR REPLACE FUNCTION private.request_begin(p_function text, p_arguments jsonb, p_request_id uuid DEFAULT NULL, p_scope text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  headers jsonb := COALESCE(NULLIF(current_setting('request.headers', true), ''), '{}')::jsonb;
  request_id uuid := COALESCE(p_request_id, NULLIF(headers->>'x-request-id', '')::uuid);
  actor uuid := auth.uid();
  saved jsonb;
  input_hash text := md5(p_arguments::text);
BEGIN
  IF request_id IS NULL AND headers ? 'authorization' AND auth.role() = 'authenticated' THEN
    RAISE EXCEPTION 'A client request ID is required.' USING ERRCODE = '22023';
  END IF;
  IF current_setting('pancake.request_active', true) = 'true' OR request_id IS NULL THEN RETURN NULL; END IF;
  IF actor IS NULL AND (auth.role() = 'service_role' OR session_user IN ('postgres', 'supabase_admin')) THEN
    actor := COALESCE(NULLIF(headers->>'x-request-actor', '')::uuid, p_actor);
  END IF;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'A verified request actor is required.' USING ERRCODE = '42501';
  END IF;
  IF p_scope IS NOT NULL THEN
    request_id := md5(request_id::text || ':' || p_function || ':' || p_scope)::uuid;
  END IF;
  PERFORM set_config('pancake.request_function', p_function, true);
  PERFORM set_config('pancake.request_input_hash', input_hash, true);
  saved := private.claim_request(request_id, actor);
  IF saved IS NOT NULL THEN
    RETURN jsonb_build_object('replay', true, 'result', saved);
  END IF;
  PERFORM set_config('pancake.request_active', 'true', true);
  RETURN jsonb_build_object('replay', false, 'id', request_id, 'actor', actor, 'function', p_function, 'input_hash', input_hash);
END;
$$;
