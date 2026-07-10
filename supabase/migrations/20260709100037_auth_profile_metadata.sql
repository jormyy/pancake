SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_requested_username text := lower(btrim(COALESCE(NEW.raw_user_meta_data->>'username', '')));
  v_email_prefix text;
  v_username_base text;
  v_username text;
  v_display_name text := btrim(COALESCE(NEW.raw_user_meta_data->>'display_name', ''));
  v_counter int;
BEGIN
  v_email_prefix := lower(regexp_replace(split_part(COALESCE(NEW.email, ''), '@', 1), '[^a-z0-9_]', '', 'g'));
  IF v_email_prefix !~ '^[a-z0-9_]{3,30}$' THEN
    v_email_prefix := 'user';
  END IF;

  v_username_base := CASE
    WHEN v_requested_username ~ '^[a-z0-9_]{3,30}$' THEN v_requested_username
    ELSE v_email_prefix
  END;
  v_display_name := regexp_replace(left(v_display_name, 100), '[[:cntrl:]]', '', 'g');
  IF v_display_name = '' THEN
    v_display_name := v_username_base;
  END IF;

  FOR v_counter IN 0..999 LOOP
    v_username := CASE
      WHEN v_counter = 0 THEN v_username_base
      ELSE left(v_username_base, 30 - length(v_counter::text)) || v_counter::text
    END;
    BEGIN
      INSERT INTO public.profiles (id, username, display_name)
      VALUES (NEW.id, v_username, v_display_name)
      ON CONFLICT (id) DO NOTHING;
      RETURN NEW;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;

  v_username := left(v_username_base, 21) || '_' || left(replace(NEW.id::text, '-', ''), 8);
  INSERT INTO public.profiles (id, username, display_name)
  VALUES (NEW.id, v_username, v_display_name)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

RESET statement_timeout;
RESET lock_timeout;
