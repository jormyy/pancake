CREATE OR REPLACE FUNCTION private.assert_legal_roster(p_league_id uuid, p_league_season_id uuid, p_member_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_kind text; v_message text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text),hashtext(p_member_id::text));
  SELECT problem.kind,string_agg(problem.message,' ' ORDER BY problem.player_name,problem.roster_player_id)
    INTO v_kind,v_message FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id) problem
    GROUP BY problem.kind ORDER BY CASE problem.kind WHEN 'ir' THEN 1 WHEN 'taxi' THEN 2 ELSE 3 END LIMIT 1;
  IF v_kind IS NOT NULL THEN
    RAISE EXCEPTION '%' ,v_message USING ERRCODE=CASE v_kind WHEN 'ir' THEN 'PA005' WHEN 'taxi' THEN 'PA009' ELSE 'PA003' END;
  END IF;
END;
$$;
