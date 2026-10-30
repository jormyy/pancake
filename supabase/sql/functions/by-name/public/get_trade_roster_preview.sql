-- Canonical SQL source for public.get_trade_roster_preview.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_trade_roster_preview(p_trade_id uuid,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_league uuid;
BEGIN
  SELECT league_id INTO v_league FROM trades WHERE id=p_trade_id;
  RETURN public.preview_trade_legality(p_user_id,v_league,NULL,NULL,'{}',p_trade_id);
END;
$$;
