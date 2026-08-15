-- Canonical SQL source for public.lineup_slot_allowed_positions.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.lineup_slot_allowed_positions(
  p_slot_type roster_slot_type
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_slot_type
    WHEN 'PG'::roster_slot_type THEN ARRAY['PG']::text[]
    WHEN 'SG'::roster_slot_type THEN ARRAY['SG']::text[]
    WHEN 'SF'::roster_slot_type THEN ARRAY['SF']::text[]
    WHEN 'PF'::roster_slot_type THEN ARRAY['PF']::text[]
    WHEN 'C'::roster_slot_type THEN ARRAY['C']::text[]
    WHEN 'G'::roster_slot_type THEN ARRAY['PG', 'SG', 'G']::text[]
    WHEN 'F'::roster_slot_type THEN ARRAY['SF', 'PF', 'F']::text[]
    WHEN 'UTIL'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    WHEN 'BE'::roster_slot_type THEN ARRAY['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
    ELSE '{}'::text[]
  END
$$;
