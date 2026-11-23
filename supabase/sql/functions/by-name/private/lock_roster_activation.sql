-- Canonical SQL source for private.lock_roster_activation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_roster_activation(
  p_activate_roster_player_id uuid,
  p_activate_source text,
  p_free_roster_player_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_target roster_players%ROWTYPE;
  v_free roster_players%ROWTYPE;
  v_current roster_players%ROWTYPE;
  v_rookie_draft_id uuid;
BEGIN
  IF p_activate_source IS NULL OR p_activate_source NOT IN ('ir', 'taxi') THEN
    RAISE EXCEPTION 'Invalid activation source.' USING ERRCODE = '22023';
  END IF;

  SELECT rp.* INTO v_target FROM roster_players AS rp
   JOIN league_members AS member ON member.id = rp.member_id
   WHERE rp.id = p_activate_roster_player_id AND member.user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to activate this roster player.' USING ERRCODE = '42501';
  END IF;

  IF p_free_roster_player_id IS NOT NULL THEN
    SELECT * INTO v_free FROM roster_players
     WHERE id = p_free_roster_player_id
       AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
       AND member_id = v_target.member_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The freed player must belong to the same roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_target.league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  PERFORM private.lock_roster_scope(v_target.league_id, ARRAY[v_target.member_id],
    ARRAY[v_target.player_id, v_free.player_id], v_rookie_draft_id);
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;
  PERFORM 1 FROM roster_players WHERE id IN (p_activate_roster_player_id, p_free_roster_player_id)
   ORDER BY id FOR UPDATE;

  SELECT * INTO v_current FROM roster_players
   WHERE id = v_target.id AND league_id = v_target.league_id AND league_season_id = v_target.league_season_id
     AND member_id = v_target.member_id AND player_id = v_target.player_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF (p_activate_source = 'ir' AND NOT v_current.is_on_ir)
     OR (p_activate_source = 'taxi' AND NOT v_current.is_on_taxi) THEN
    RAISE EXCEPTION 'This player is no longer on %. Refresh your roster and try again.', upper(p_activate_source)
      USING ERRCODE = 'P0001';
  END IF;

  IF p_free_roster_player_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM roster_players WHERE id = v_free.id AND league_id = v_target.league_id
      AND league_season_id = v_target.league_season_id AND member_id = v_target.member_id
      AND player_id = v_free.player_id
  ) THEN
    RAISE EXCEPTION 'This roster changed. Refresh and try again.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
