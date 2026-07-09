-- Canonical SQL source for public.set_waiver_clears_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION set_waiver_clears_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.clears_at = NEW.placed_on_waivers_at + INTERVAL '48 hours';
  RETURN NEW;
END;
$$;
