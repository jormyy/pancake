-- Canonical SQL source for private.player_import_name_key.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_import_name_key(p_name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v_space text := E'\t\n\013\f\r ' || U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  v_name text;
BEGIN
  v_name := lower(regexp_replace(normalize(p_name, NFD), U&'[\0300-\036F]', '', 'g'));
  v_name := regexp_replace(v_name, '[' || v_space || ']+(jr\.?|sr\.?|ii|iii|iv|v)$', '');
  v_name := regexp_replace(v_name, U&'[.\0027\2019-]', '', 'g');
  v_name := btrim(regexp_replace(v_name, '[' || v_space || ']+', ' ', 'g'), ' ');
  RETURN CASE v_name WHEN 'valdez edgecombe' THEN 'vj edgecombe'
    WHEN 'airious bailey' THEN 'ace bailey' ELSE v_name END;
END;
$$;
