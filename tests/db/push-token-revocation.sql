BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000090001', 'authenticated', 'authenticated', 'push-revoke-a@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000090002', 'authenticated', 'authenticated', 'push-revoke-b@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-000000090001', 'push_revoke_a', 'Push Revoke A'),
  ('00000000-0000-0000-0000-000000090002', 'push_revoke_b', 'Push Revoke B')
ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, display_name = EXCLUDED.display_name;

-- Simulate the previous Edge implementation against the upgraded schema.
UPDATE public.profiles
   SET push_token = 'ExponentPushToken[legacy-edge]'
 WHERE id = '00000000-0000-0000-0000-000000090001';

DO $$
DECLARE
  v_hash text;
BEGIN
  SELECT push_token_revocation_hash INTO v_hash
    FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-000000090001';
  IF v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Legacy token-only registration did not receive an unknown credential.';
  END IF;

  UPDATE public.profiles
     SET push_token = 'ExponentPushToken[legacy-edge-rotated]'
   WHERE id = '00000000-0000-0000-0000-000000090001';
  IF (SELECT push_token_revocation_hash FROM public.profiles
       WHERE id = '00000000-0000-0000-0000-000000090001') = v_hash THEN
    RAISE EXCEPTION 'Legacy token rotation retained a stale credential.';
  END IF;

  UPDATE public.profiles
     SET push_token = NULL
   WHERE id = '00000000-0000-0000-0000-000000090001';
  IF EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090001'
       AND (push_token IS NOT NULL OR push_token_revocation_hash IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Legacy token clear did not clear the paired credential.';
  END IF;
END;
$$;

SELECT public.register_push_token_atomic(
  '00000000-0000-0000-0000-000000090001',
  'ExponentPushToken[credential-test]',
  repeat('a', 64)
);

SELECT public.register_push_token_atomic(
  '00000000-0000-0000-0000-000000090002',
  'ExponentPushToken[credential-test]',
  repeat('b', 64)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090001'
       AND (push_token IS NOT NULL OR push_token_revocation_hash IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Token transfer retained the prior owner credential.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090002'
       AND push_token = 'ExponentPushToken[credential-test]'
       AND push_token_revocation_hash = repeat('b', 64)
  ) THEN
    RAISE EXCEPTION 'Token transfer did not rotate ownership and credential atomically.';
  END IF;

  IF public.revoke_push_token_atomic('ExponentPushToken[credential-test]', repeat('a', 64)) THEN
    RAISE EXCEPTION 'A stale revocation credential cleared the new owner token.';
  END IF;
  IF NOT public.revoke_push_token_atomic('ExponentPushToken[credential-test]', repeat('b', 64)) THEN
    RAISE EXCEPTION 'The current revocation credential did not clear the token.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090002'
       AND (push_token IS NOT NULL OR push_token_revocation_hash IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Credential revocation did not clear both sensitive columns.';
  END IF;
END;
$$;

SELECT public.register_push_token_atomic(
  '00000000-0000-0000-0000-000000090001',
  'ExponentPushToken[owner-clear-test]',
  repeat('c', 64)
);

DO $$
BEGIN
  IF public.clear_push_token_for_user_atomic(
    '00000000-0000-0000-0000-000000090002',
    'ExponentPushToken[owner-clear-test]'
  ) THEN
    RAISE EXCEPTION 'A different owner cleared the token.';
  END IF;
  IF NOT public.clear_push_token_for_user_atomic(
    '00000000-0000-0000-0000-000000090001',
    'ExponentPushToken[owner-clear-test]'
  ) THEN
    RAISE EXCEPTION 'The owning user could not clear its exact token.';
  END IF;
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.revoke_push_token_atomic('ExponentPushToken[credential-test]', repeat('b', 64));
    RAISE EXCEPTION 'authenticated unexpectedly executed the revocation RPC';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

ROLLBACK;
