CREATE OR REPLACE FUNCTION private.notif_player_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  r record;
  v_occurrence text := NEW.id::text || ':' || gen_random_uuid()::text;
BEGIN
  IF OLD.injury_status IS NOT DISTINCT FROM NEW.injury_status THEN RETURN NEW; END IF;
  FOR r IN SELECT DISTINCT roster.league_id,roster.member_id FROM public.roster_players roster
    JOIN public.league_seasons season ON season.id = roster.league_season_id AND season.is_current
    WHERE roster.player_id = NEW.id LOOP
    PERFORM private.notif_enqueue('owned_player_status',v_occurrence,r.league_id,r.member_id,
      jsonb_build_object('playerId',NEW.id,'body',NEW.display_name || ': ' || COALESCE(NEW.injury_status,'Available')));
    IF NEW.injury_status IS NOT NULL AND lower(NEW.injury_status) NOT IN ('healthy','active','available') THEN
      PERFORM private.notif_enqueue('owned_player_injured',v_occurrence,r.league_id,r.member_id,jsonb_build_object('playerId',NEW.id));
    END IF;
    IF lower(NEW.injury_status) IN ('out','o','ruled out') THEN
      PERFORM private.notif_enqueue('owned_player_ruled_out',v_occurrence,r.league_id,r.member_id,jsonb_build_object('playerId',NEW.id));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
