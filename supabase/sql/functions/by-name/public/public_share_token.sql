CREATE OR REPLACE FUNCTION public.public_share_token(p_league_id uuid, p_action text DEFAULT 'create')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE share text;
BEGIN
  IF NOT private.is_commissioner(p_league_id) THEN
    RAISE EXCEPTION 'Only a commissioner can manage public sharing.' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('create', 'rotate', 'revoke') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Unknown sharing action.' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_league_id::text, 9182));
  IF p_action = 'revoke' THEN
    UPDATE public.league_share_tokens SET revoked_at = now() WHERE league_id = p_league_id;
    RETURN jsonb_build_object('enabled', false);
  END IF;
  IF p_action = 'create' AND EXISTS (SELECT 1 FROM public.league_share_tokens WHERE league_id = p_league_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Sharing already exists. Rotate to replace the token.' USING ERRCODE = '22023';
  END IF;
  share := encode(extensions.gen_random_bytes(32), 'hex');
  INSERT INTO public.league_share_tokens(league_id, token_hash)
  VALUES (p_league_id, encode(extensions.digest(share, 'sha256'), 'hex'))
  ON CONFLICT (league_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, revoked_at = NULL, created_at = now(),
    window_started_at = date_trunc('minute', now()), window_reads = 0;
  RETURN jsonb_build_object('enabled', true, 'token', share);
END;
$$;
