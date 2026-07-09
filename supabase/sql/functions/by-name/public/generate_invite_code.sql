-- Canonical SQL source for public.generate_invite_code.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := upper(encode(extensions.gen_random_bytes(8), 'hex'));
    EXIT WHEN NOT EXISTS (
      SELECT 1
        FROM public.leagues
       WHERE invite_code = v_code
    );
  END LOOP;

  RETURN v_code;
END;
$$;
