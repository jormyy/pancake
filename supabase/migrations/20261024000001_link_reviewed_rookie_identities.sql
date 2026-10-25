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

REINDEX INDEX public.idx_players_import_normalized_name;

DO $$
DECLARE
  v_alias record;
  v_draft uuid[];
  v_owner uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(1347174745, 1);
  FOR v_alias IN SELECT * FROM (VALUES
    ('1642845', '5124612', 3, 'vj edgecombe'),
    ('1642846', '4873138', 5, 'ace bailey')
  ) AS aliases(nba_id, espn_id, draft_number, name_key) LOOP
    SELECT id INTO v_owner FROM public.players WHERE nba_id = v_alias.nba_id FOR UPDATE;
    IF v_owner IS NULL THEN CONTINUE; END IF;
    SELECT array_agg(id) INTO v_draft FROM public.players
      WHERE id <> v_owner AND nba_draft_number = v_alias.draft_number AND years_exp = 0
        AND nba_id IS NULL AND private.player_import_name_key(display_name) = v_alias.name_key;
    IF coalesce(cardinality(v_draft), 0) = 0 THEN CONTINUE; END IF;
    IF cardinality(v_draft) <> 1 OR NOT EXISTS (
      SELECT FROM public.players WHERE id = v_owner
        AND private.player_import_name_key(display_name) = v_alias.name_key
        AND (espn_id IS NULL OR espn_id = v_alias.espn_id)
    ) THEN
      RAISE EXCEPTION 'Reviewed rookie identity has conflicting candidates: %.', v_alias.name_key USING ERRCODE = '23514';
    END IF;
    PERFORM public.merge_players(v_draft[1], v_owner);
  END LOOP;
END;
$$;
