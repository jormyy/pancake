CREATE OR REPLACE FUNCTION private.valid_player_birthdate(p_birthdate date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT p_birthdate >= DATE '1900-01-01' AND p_birthdate <= now()::date;
$$;

REVOKE ALL ON FUNCTION private.valid_player_birthdate(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.valid_player_birthdate(date) TO service_role;
ALTER TABLE public.players DROP CONSTRAINT players_birthdate_check;
ALTER TABLE public.players ADD CONSTRAINT players_birthdate_check CHECK (private.valid_player_birthdate(birthdate));
