-- Canonical SQL source for private.recount_changed_player_careers.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.recount_changed_player_careers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ids uuid[];
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT array_agg(DISTINCT n.player_id) INTO v_ids FROM career_new_rows n
      WHERE private.player_game_appeared(n::public.player_game_stats);
  ELSIF TG_OP='DELETE' THEN
    SELECT array_agg(DISTINCT o.player_id) INTO v_ids FROM career_old_rows o
      WHERE private.player_game_appeared(o::public.player_game_stats);
  ELSE
    SELECT array_agg(DISTINCT player_id) INTO v_ids FROM (
      SELECT n.player_id FROM career_new_rows n FULL JOIN career_old_rows o USING(id)
        WHERE (n.player_id,n.game_id,private.player_game_appeared(n::public.player_game_stats))
          IS DISTINCT FROM (o.player_id,o.game_id,private.player_game_appeared(o::public.player_game_stats))
      UNION
      SELECT o.player_id FROM career_old_rows o FULL JOIN career_new_rows n USING(id)
        WHERE (n.player_id,n.game_id,private.player_game_appeared(n::public.player_game_stats))
          IS DISTINCT FROM (o.player_id,o.game_id,private.player_game_appeared(o::public.player_game_stats))
    ) changed WHERE player_id IS NOT NULL;
  END IF;
  PERFORM private.recount_player_career_games(v_ids);
  RETURN NULL;
END;
$$;
