BEGIN;
DO $$
DECLARE
  v_alias record;
  v_draft uuid;
  v_provider text;
  v_result uuid;
  v_nba text;
  v_receipt jsonb;
BEGIN
  FOR v_alias IN SELECT * FROM (VALUES ('VJ','Valdez','Edgecombe',3),('Ace','Airious','Bailey',5)) AS a(draft_first,provider_first,last_name,pick) LOOP
    v_draft := gen_random_uuid();
    v_provider := 'alias-'||gen_random_uuid()::text;
    v_nba := 'alias-nba-'||gen_random_uuid()::text;
    UPDATE players SET first_name='Held'||id::text,last_name='Identity'
      WHERE private.player_import_name_key(display_name) = private.player_import_name_key(v_alias.draft_first||' '||v_alias.last_name);
    INSERT INTO players(id,first_name,last_name,years_exp,nba_draft_number)
      VALUES(v_draft,v_alias.draft_first,v_alias.last_name,0,v_alias.pick);
    v_receipt := resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_provider,'first_name',v_alias.provider_first,'last_name',v_alias.last_name,
      'metadata',jsonb_build_object('nba_team','PHI','position','G'))));
    v_result := (v_receipt->'results'->0->>'player_id')::uuid;
    IF v_result IS DISTINCT FROM v_draft THEN RAISE EXCEPTION 'Reviewed alias forks draft identity'; END IF;
    v_receipt := resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_nba,'display_name',v_alias.draft_first||' '||v_alias.last_name)));
    IF (v_receipt->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_draft THEN
      RAISE EXCEPTION 'The first NBA box loses the aliased draft row';
    END IF;
    IF NOT EXISTS (SELECT FROM players WHERE id=v_draft AND nba_draft_number=v_alias.pick
        AND nba_id=v_nba AND espn_id=v_provider AND nba_team='PHI') THEN
      RAISE EXCEPTION 'Reviewed alias loses provider, pick or team metadata';
    END IF;
    IF private.player_import_name_key('Valdez Edgecombe Jr.') <> private.player_import_name_key('V.J. Edgecombe')
      OR private.player_import_name_key('Valdez Edgecomb') = private.player_import_name_key('VJ Edgecombe') THEN
      RAISE EXCEPTION 'Reviewed alias expands beyond its exact spelling';
    END IF;
    INSERT INTO players(first_name,last_name) VALUES(v_alias.provider_first,v_alias.last_name||' Jr.');
    v_receipt := resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object(
      'provider_id',v_nba||'-ambiguous','display_name',v_alias.draft_first||' '||v_alias.last_name||' Sr.')));
    IF v_receipt->'results'->0->>'action' <> 'ambiguous'
      OR v_receipt->'results'->0->>'player_id' IS NOT NULL THEN
      RAISE EXCEPTION 'A reviewed alias must not bypass ambiguity checks';
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS two reviewed aliases: draft, ESPN, NBA, metadata, exact spelling and ambiguity';
END $$;
ROLLBACK;
