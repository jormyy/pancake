BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  (
    '00000000-0000-0000-0000-000000090101', 'authenticated', 'authenticated',
    'metadata-a@example.test', 'x', now(), '{}'::jsonb,
    '{"username":"requested_name","display_name":"  Requested Name  "}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000090102', 'authenticated', 'authenticated',
    'metadata-b@example.test', 'x', now(), '{}'::jsonb,
    '{"username":"requested_name","display_name":"Second User"}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000090103', 'authenticated', 'authenticated',
    'fallback.user@example.test', 'x', now(), '{}'::jsonb,
    '{"username":"INVALID USER!","display_name":""}'::jsonb, now(), now()
  );

DO $$
DECLARE
  v_second_username text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090101'
       AND username = 'requested_name'
       AND display_name = 'Requested Name'
  ) THEN
    RAISE EXCEPTION 'Auth metadata was not preserved by the profile trigger.';
  END IF;

  SELECT username INTO v_second_username
    FROM public.profiles
   WHERE id = '00000000-0000-0000-0000-000000090102';
  IF v_second_username !~ '^requested_name[0-9]+$' THEN
    RAISE EXCEPTION 'Duplicate requested username did not receive a safe suffix: %', v_second_username;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = '00000000-0000-0000-0000-000000090103'
       AND username = 'fallbackuser'
       AND display_name = 'fallbackuser'
  ) THEN
    RAISE EXCEPTION 'Invalid metadata did not use the safe email fallback.';
  END IF;
END;
$$;

ROLLBACK;
