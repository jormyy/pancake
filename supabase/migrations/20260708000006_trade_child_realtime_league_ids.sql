-- Denormalize trade child rows by league so realtime subscribers can filter
-- high-volume child-table events without refetching every open trade surface.
ALTER TABLE public.trade_items
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES public.leagues(id);

ALTER TABLE public.trade_participants
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES public.leagues(id);

ALTER TABLE public.trade_vetos
  ADD COLUMN IF NOT EXISTS league_id uuid REFERENCES public.leagues(id);

UPDATE public.trade_items AS item
   SET league_id = trade.league_id
  FROM public.trades AS trade
 WHERE trade.id = item.trade_id
   AND item.league_id IS NULL;

UPDATE public.trade_participants AS participant
   SET league_id = trade.league_id
  FROM public.trades AS trade
 WHERE trade.id = participant.trade_id
   AND participant.league_id IS NULL;

UPDATE public.trade_vetos AS veto
   SET league_id = trade.league_id
  FROM public.trades AS trade
 WHERE trade.id = veto.trade_id
   AND veto.league_id IS NULL;

ALTER TABLE public.trade_items
  ALTER COLUMN league_id SET NOT NULL;

ALTER TABLE public.trade_participants
  ALTER COLUMN league_id SET NOT NULL;

ALTER TABLE public.trade_vetos
  ALTER COLUMN league_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_items_league_trade
  ON public.trade_items(league_id, trade_id);

CREATE INDEX IF NOT EXISTS idx_trade_participants_league_member
  ON public.trade_participants(league_id, member_id, trade_id);

CREATE INDEX IF NOT EXISTS idx_trade_vetos_league_trade
  ON public.trade_vetos(league_id, trade_id);

CREATE OR REPLACE FUNCTION private.set_trade_child_league_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_league_id uuid;
BEGIN
  SELECT league_id INTO v_league_id
    FROM public.trades
   WHERE id = NEW.trade_id;

  IF v_league_id IS NULL THEN
    RAISE EXCEPTION 'Trade child row references an unknown trade.';
  END IF;

  IF NEW.league_id IS NOT NULL AND NEW.league_id <> v_league_id THEN
    RAISE EXCEPTION 'Trade child league_id must match the parent trade.';
  END IF;

  NEW.league_id := v_league_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_trade_items_league_id ON public.trade_items;
CREATE TRIGGER set_trade_items_league_id
BEFORE INSERT OR UPDATE OF trade_id, league_id ON public.trade_items
FOR EACH ROW
EXECUTE FUNCTION private.set_trade_child_league_id();

DROP TRIGGER IF EXISTS set_trade_participants_league_id ON public.trade_participants;
CREATE TRIGGER set_trade_participants_league_id
BEFORE INSERT OR UPDATE OF trade_id, league_id ON public.trade_participants
FOR EACH ROW
EXECUTE FUNCTION private.set_trade_child_league_id();

DROP TRIGGER IF EXISTS set_trade_vetos_league_id ON public.trade_vetos;
CREATE TRIGGER set_trade_vetos_league_id
BEFORE INSERT OR UPDATE OF trade_id, league_id ON public.trade_vetos
FOR EACH ROW
EXECUTE FUNCTION private.set_trade_child_league_id();

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'trade_items',
    'trade_participants',
    'trade_vetos'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', v_table);

    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;
