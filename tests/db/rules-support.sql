SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rules_checks (label text PRIMARY KEY);

CREATE FUNCTION pg_temp.check_rules(p_ok boolean, p_label text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', p_label;
  END IF;
  INSERT INTO rules_checks VALUES (p_label);
END;
$$;

CREATE FUNCTION pg_temp.reject_rules(p_command text, p_message text, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_message text;
BEGIN
  BEGIN
    EXECUTE p_command;
  EXCEPTION WHEN OTHERS THEN
    v_message := SQLERRM;
  END;
  PERFORM pg_temp.check_rules(v_message LIKE p_message, p_label || COALESCE(': ' || v_message, ': unexpected success'));
END;
$$;

CREATE FUNCTION pg_temp.rules_fixture(p_teams int, p_year int, p_status public.league_status DEFAULT 'active')
RETURNS TABLE (league_id uuid, season_id uuid, user_ids uuid[], member_ids uuid[])
LANGUAGE plpgsql AS $$
DECLARE
  v_index int;
BEGIN
  league_id := gen_random_uuid();
  season_id := gen_random_uuid();
  user_ids := ARRAY[]::uuid[];
  member_ids := ARRAY[]::uuid[];
  FOR v_index IN 1..p_teams LOOP
    user_ids := array_append(user_ids, gen_random_uuid());
    member_ids := array_append(member_ids, gen_random_uuid());
    INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES(user_ids[v_index], 'authenticated', 'authenticated', user_ids[v_index] || '@example.test',
      'x', now(), '{}', '{}', now(), now());
  END LOOP;
  INSERT INTO public.leagues(id, name, slug, commissioner_id, status, weekly_add_limit)
  VALUES(league_id, 'Rules fixture', league_id::text, user_ids[1], p_status, NULL);
  INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
  VALUES(season_id, league_id, p_year, true);
  FOR v_index IN 1..p_teams LOOP
    INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
    VALUES(member_ids[v_index], league_id, user_ids[v_index],
      CASE WHEN v_index = 1 THEN 'commissioner' ELSE 'manager' END::public.league_member_role,
      'Rules team ' || v_index);
    INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
    VALUES(league_id, season_id, member_ids[v_index], v_index);
  END LOOP;
  RETURN NEXT;
END;
$$;
