-- Canonical SQL source for private.ir_reliable_return.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.ir_reliable_return(p_value text, p_today date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  v_date date;
BEGIN
  IF p_value IS NULL OR p_value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_date := p_value::date;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  IF v_date >= p_today THEN
    RETURN v_date;
  END IF;
  RETURN NULL;
END;
$function$;
