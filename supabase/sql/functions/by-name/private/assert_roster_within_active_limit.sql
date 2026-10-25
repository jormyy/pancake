-- Canonical SQL source for private.assert_roster_within_active_limit.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_roster_within_active_limit(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_league_id::text),
    hashtext(p_member_id::text)
  );

  PERFORM 1
    FROM leagues
   WHERE id = p_league_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM private.roster_problems(p_league_id,p_league_season_id,p_member_id)
    WHERE kind='active_limit') THEN
    RAISE EXCEPTION 'Roster is over the active player limit. Drop or move an eligible player to IR/taxi before editing your lineup.'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
