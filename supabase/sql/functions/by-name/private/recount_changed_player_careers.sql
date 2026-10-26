CREATE OR REPLACE FUNCTION private.recount_changed_player_careers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ids uuid[];
BEGIN
  IF TG_OP='INSERT' THEN SELECT array_agg(DISTINCT player_id) INTO v_ids FROM career_new_rows;
  ELSIF TG_OP='DELETE' THEN SELECT array_agg(DISTINCT player_id) INTO v_ids FROM career_old_rows;
  ELSE SELECT array_agg(player_id) INTO v_ids FROM (SELECT player_id FROM career_new_rows UNION SELECT player_id FROM career_old_rows) changed;
  END IF;
  PERFORM private.recount_player_career_games(v_ids);
  RETURN NULL;
END;
$$;
