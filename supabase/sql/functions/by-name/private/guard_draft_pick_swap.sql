-- Canonical SQL source for private.guard_draft_pick_swap.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.guard_draft_pick_swap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.league_members
     WHERE league_id = NEW.league_id AND id IN (NEW.holder_member_id, NEW.counterparty_member_id)
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Both swap teams must belong to the league.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.draft_pick_swaps other
     WHERE other.id <> NEW.id
       AND other.league_id = NEW.league_id
       AND other.season_year = NEW.season_year
       AND other.round = NEW.round
       AND ARRAY[other.holder_member_id, other.counterparty_member_id]
           && ARRAY[NEW.holder_member_id, NEW.counterparty_member_id]
  ) THEN
    RAISE EXCEPTION 'A pick can be part of only one swap per round.' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
