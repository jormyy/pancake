-- Canonical SQL source for private.notif_league_trade_trigger.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.notif_league_trade_trigger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  m record;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status OR NEW.status <> 'completed' THEN RETURN NEW; END IF;
  FOR m IN SELECT id FROM public.league_members member WHERE league_id = NEW.league_id
    AND NOT EXISTS (SELECT 1 FROM public.trade_participants participant WHERE participant.trade_id = NEW.id AND participant.member_id = member.id)
  LOOP
    PERFORM private.notif_enqueue('league_trade',NEW.id::text,NEW.league_id,m.id,jsonb_build_object('tradeId',NEW.id));
  END LOOP;
  RETURN NEW;
END;
$$;
