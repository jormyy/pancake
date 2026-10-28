CREATE OR REPLACE FUNCTION private.valid_player_birthdate(p_birthdate date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_birthdate >= DATE '1900-01-01' AND p_birthdate <= now()::date;
$$;
