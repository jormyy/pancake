-- Canonical SQL source for private.lock_roster_scope.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.lock_roster_scope(
  p_league_id uuid,
  p_member_ids uuid[],
  p_player_ids uuid[],
  p_draft_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_member_id uuid;
  v_player_id uuid;
BEGIN
  IF p_league_id IS NULL AND (
    EXISTS (SELECT 1 FROM unnest(p_member_ids) AS member_id WHERE member_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM unnest(p_player_ids) AS player_id WHERE player_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Roster locks need a league.' USING ERRCODE = '22004';
  END IF;
  IF p_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);
  END IF;
  FOR v_member_id IN
    SELECT DISTINCT member_id FROM unnest(p_member_ids) AS member_id
     WHERE member_id IS NOT NULL ORDER BY member_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_member_id::text));
  END LOOP;
  FOR v_player_id IN
    SELECT DISTINCT player_id FROM unnest(p_player_ids) AS player_id
     WHERE player_id IS NOT NULL ORDER BY player_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext(p_league_id::text), hashtext(v_player_id::text));
  END LOOP;
END;
$$;
