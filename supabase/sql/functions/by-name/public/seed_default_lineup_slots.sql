-- Canonical SQL source for public.seed_default_lineup_slots.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION seed_default_lineup_slots()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO lineup_slot_templates (league_id, slot_type, slot_count)
  VALUES
    (NEW.id, 'PG',   1),
    (NEW.id, 'SG',   1),
    (NEW.id, 'SF',   1),
    (NEW.id, 'PF',   1),
    (NEW.id, 'C',    1),
    (NEW.id, 'G',    1),
    (NEW.id, 'F',    1),
    (NEW.id, 'UTIL', 3),
    (NEW.id, 'BE',   10),
    (NEW.id, 'IR',   2);
  RETURN NEW;
END;
$$;
