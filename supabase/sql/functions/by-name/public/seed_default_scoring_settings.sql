-- Canonical SQL source for public.seed_default_scoring_settings.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION seed_default_scoring_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.scoring_settings = '{}' THEN
    NEW.scoring_settings = '{
      "points": 1.0,
      "rebounds": 1.2,
      "assists": 1.5,
      "steals": 3.0,
      "blocks": 3.0,
      "turnovers": -1.0,
      "three_pointers_made": 0.5,
      "double_double": 1.5,
      "triple_double": 3.0
    }'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;
