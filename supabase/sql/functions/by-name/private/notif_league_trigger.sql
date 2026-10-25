CREATE OR REPLACE FUNCTION private.notif_league_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
  v_occurrence text := NEW.id::text || ':' || gen_random_uuid()::text;
  v_ignored text[] := ARRAY['id','created_at','updated_at','status','deleted_at','deleted_by','invite_code','slug','taxi_rule'];
BEGIN
  IF (to_jsonb(OLD) - v_ignored) IS NOT DISTINCT FROM (to_jsonb(NEW) - v_ignored) THEN RETURN NEW; END IF;
  FOR m IN SELECT id FROM public.league_members WHERE league_id = NEW.id LOOP
    PERFORM private.notif_enqueue('league_settings_changed',v_occurrence,NEW.id,m.id,jsonb_build_object('leagueId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;
