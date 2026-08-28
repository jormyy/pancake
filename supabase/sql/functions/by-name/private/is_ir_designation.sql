-- Canonical SQL source for private.is_ir_designation.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.is_ir_designation(p_injury_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(COALESCE(p_injury_status, '')) = 'out'
      OR lower(COALESCE(p_injury_status, '')) LIKE 'ir%'
$$;
