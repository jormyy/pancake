CREATE OR REPLACE FUNCTION private.notif_scan_lineups(p_now timestamptz DEFAULT now())
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM private.notif_lineup_candidates(p_now) LOOP
    PERFORM private.notif_enqueue(r.event_type,r.league_id || ':' || r.game_date || COALESCE(':' || r.player_id,''),r.league_id,r.member_id,
      jsonb_build_object('memberId',r.member_id,'gameDate',r.game_date,'playerId',r.player_id));
  END LOOP;
END;
$$;
