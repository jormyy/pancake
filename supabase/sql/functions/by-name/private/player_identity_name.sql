CREATE OR REPLACE FUNCTION private.player_identity_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT regexp_replace(lower(regexp_replace(normalize(p_name, NFD), U&'[\0300-\036F]', '', 'g')), '[^a-z]', '', 'g');
$$;
