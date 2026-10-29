CREATE OR REPLACE FUNCTION private.notif_lineup_candidates(p_now timestamptz DEFAULT now())
RETURNS TABLE(event_type text,league_id uuid,member_id uuid,player_id uuid,game_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT event_type,league_id,member_id,player_id,game_date
  FROM private.notif_lineup_candidates_scoped(p_now,NULL,NULL);
$$;
