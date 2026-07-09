-- Canonical SQL source for public.handle_new_auth_user.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email_prefix text;
  v_username     text;
  v_counter      int := 0;
BEGIN
  -- Derive a username from the email prefix, stripping non-alphanumeric chars
  v_email_prefix := lower(regexp_replace(split_part(NEW.email, '@', 1), '[^a-z0-9_]', '', 'g'));
  IF length(v_email_prefix) < 3 THEN
    v_email_prefix := 'user';
  END IF;
  v_username := v_email_prefix;

  -- Ensure uniqueness with a numeric suffix if needed
  WHILE EXISTS (SELECT 1 FROM public.profiles WHERE username = v_username) LOOP
    v_counter  := v_counter + 1;
    v_username := v_email_prefix || v_counter::text;
    IF v_counter > 999 THEN EXIT; END IF; -- safety valve
  END LOOP;

  INSERT INTO public.profiles (id, username, display_name)
  VALUES (
    NEW.id,
    v_username,
    COALESCE(NEW.raw_user_meta_data->>'display_name', v_email_prefix)
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;
