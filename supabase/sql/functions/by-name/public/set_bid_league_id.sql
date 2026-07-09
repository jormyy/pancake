-- Canonical SQL source for public.set_bid_league_id.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_bid_league_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  SELECT d.league_id
  INTO   NEW.league_id
  FROM   nominations n
  JOIN   drafts d ON d.id = n.draft_id
  WHERE  n.id = NEW.nomination_id;
  RETURN NEW;
END;
$$;
