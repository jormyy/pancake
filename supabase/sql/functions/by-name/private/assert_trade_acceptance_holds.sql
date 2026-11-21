-- Canonical SQL source for private.assert_trade_acceptance_holds.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_trade_acceptance_holds(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_include_trade_id uuid DEFAULT NULL,
  p_commit_trade boolean DEFAULT false,
  p_actor_member_id uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  PERFORM private.assert_trade_roster_holds(p_league_id,p_season_id,p_member_id,NULL,'add',p_include_trade_id,p_commit_trade,p_actor_member_id,NULL);
END;
$$;
