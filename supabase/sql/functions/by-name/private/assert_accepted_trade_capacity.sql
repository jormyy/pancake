-- Canonical SQL source for private.assert_accepted_trade_capacity.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid,p_season_id uuid,p_member_id uuid,p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  v_baseline jsonb;
  v_member_baseline jsonb;
BEGIN
  v_baseline := COALESCE(NULLIF(current_setting('pancake.trade_hold_baseline', true), ''), '{}')::jsonb;
  v_member_baseline := v_baseline->(p_member_id::text)->'counts';
  PERFORM private.assert_trade_roster_holds(p_league_id,p_season_id,p_member_id,NULL,'drop',p_include_trade_id,false,NULL,v_member_baseline);
END;
$$;
