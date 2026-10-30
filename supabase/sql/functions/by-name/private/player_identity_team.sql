-- Canonical SQL source for private.player_identity_team.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.player_identity_team(p_team text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT CASE upper(btrim(p_team)) WHEN 'SA' THEN 'SAS' WHEN 'GS' THEN 'GSW'
    WHEN 'NY' THEN 'NYK' WHEN 'NO' THEN 'NOP' WHEN 'NOR' THEN 'NOP'
    WHEN 'PHO' THEN 'PHX' WHEN 'WSH' THEN 'WAS' WHEN 'UTAH' THEN 'UTA'
    WHEN 'BRK' THEN 'BKN' WHEN 'CHO' THEN 'CHA' ELSE upper(btrim(p_team)) END;
$$;
