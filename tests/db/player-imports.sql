BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  v_tag text := 'Import' || replace(gen_random_uuid()::text, '-', '');
  v_result jsonb;
  v_id uuid;
  v_other uuid;
  v_original jsonb;
  v_board jsonb;
  v_before text;
  v_after text;
  v_count int;
BEGIN
  IF has_function_privilege('anon', 'public.resolve_player_imports_atomic(text,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.resolve_player_imports_atomic(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Client roles can mutate provider identities';
  END IF;
  v_result := resolve_player_imports_atomic('nba_cdn', jsonb_build_array(jsonb_build_object(
    'provider_id', v_tag || '-nba', 'display_name', 'First ' || v_tag)));
  v_id := (v_result->'results'->0->>'player_id')::uuid;
  IF v_result->'results'->0->>'action' <> 'inserted' THEN RAISE EXCEPTION 'Initial import did not insert'; END IF;
  UPDATE players SET position='SG', eligible_positions=ARRAY['SG','SF'], headshot_url='https://example.test/picture',
    nba_draft_number=7 WHERE id=v_id;
  v_result := resolve_player_imports_atomic('espn', jsonb_build_array(jsonb_build_object(
    'provider_id', v_tag || '-espn', 'first_name', 'First', 'last_name', v_tag,
    'metadata', jsonb_build_object('position','G','eligible_positions',ARRAY['G'],'nba_team','BOS',
      'status','ACT','injury_status',NULL,'years_exp',4))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id OR v_result->'results'->0->>'action' IS DISTINCT FROM 'updated'
    OR NOT EXISTS(SELECT FROM players WHERE id=v_id AND nba_id=v_tag||'-nba' AND espn_id=v_tag||'-espn'
      AND position='SG' AND eligible_positions=ARRAY['SG','SF'] AND nba_team='BOS' AND years_exp=4
      AND nba_draft_number=7 AND headshot_url='https://example.test/picture') THEN
    RAISE EXCEPTION 'ESPN lost canonical identity or richer metadata';
  END IF;
  -- Stable provider ownership wins even when its current name changes.
  v_result := resolve_player_imports_atomic('espn', jsonb_build_array(jsonb_build_object(
    'provider_id', v_tag || '-espn', 'first_name', 'FIRST', 'last_name', v_tag,
    'metadata', jsonb_build_object('position','G','eligible_positions',ARRAY['G'],'nba_team','NYK',
      'status','ACT','injury_status','Out','years_exp',5))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'Provider rename forked identity'; END IF;
  SELECT to_jsonb(p) INTO v_original FROM players p WHERE id=v_id;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_cdn', jsonb_build_array(
      jsonb_build_object('provider_id',v_tag||'-fresh','display_name','Fresh '||v_tag),
      jsonb_build_object('provider_id',v_tag||'-conflict','display_name','FIRST '||v_tag)));
    RAISE EXCEPTION 'Conflicting provider identity was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS(SELECT FROM players WHERE nba_id=v_tag||'-fresh')
    OR (SELECT to_jsonb(p) FROM players p WHERE id=v_id) IS DISTINCT FROM v_original THEN
    RAISE EXCEPTION 'Rejected import did not roll back every write';
  END IF;

  -- A unique exact name stays usable when suffix normalization is ambiguous.
  INSERT INTO players(first_name,last_name) VALUES('Exact',v_tag),('Exact',v_tag||' Jr.');
  v_result := resolve_player_imports_atomic('nba_cdn', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-exact','display_name','Exact '||v_tag)));
  IF v_result->'results'->0->>'action' <> 'updated' THEN RAISE EXCEPTION 'Unique exact match lost'; END IF;
  v_result := resolve_player_imports_atomic('nba_cdn', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-ambiguous','display_name','Exact '||v_tag||' Sr.')));
  IF v_result->'results'->0->>'action' <> 'ambiguous'
    OR v_result->'results'->0->>'player_id' IS NOT NULL
    OR EXISTS(SELECT FROM players WHERE nba_id=v_tag||'-ambiguous') THEN RAISE EXCEPTION 'Ambiguous import guessed'; END IF;

  v_result := resolve_player_imports_atomic('sleeper', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-sleeper','first_name','FIRST','last_name',v_tag,
    'metadata',jsonb_build_object('position','PG','eligible_positions',ARRAY['PG'],'nba_team','NYK',
      'status','ACT','injury_status',NULL,'years_exp',6))));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id OR NOT EXISTS(
    SELECT FROM players WHERE id=v_id AND sleeper_id=v_tag||'-sleeper' AND position='PG'
      AND eligible_positions=ARRAY['PG'] AND espn_id=v_tag||'-espn' AND nba_id=v_tag||'-nba') THEN
    RAISE EXCEPTION 'Sleeper authoritative metadata or atomic claim failed';
  END IF;

  v_result := resolve_player_imports_atomic('nba_index', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-nba','player_id',v_id,'expected_display_name','First '||v_tag,'name_match','exact')));
  IF v_result->'results'->0->>'action' <> 'stale' THEN RAISE EXCEPTION 'Stale index name accepted'; END IF;
  v_result := resolve_player_imports_atomic('nba_index', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-nba','player_id',gen_random_uuid(),'expected_display_name','Missing','name_match','exact')));
  IF v_result->'results'->0->>'action' <> 'missing' THEN RAISE EXCEPTION 'Index resurrected missing row'; END IF;
  INSERT INTO players(first_name,last_name) VALUES('Unclaimed',v_tag) RETURNING id INTO v_other;
  v_result := resolve_player_imports_atomic('nba_index', jsonb_build_array(jsonb_build_object(
    'provider_id',v_tag||'-nba','player_id',v_other,'expected_display_name','Unclaimed '||v_tag,'name_match','exact')));
  IF (v_result->'results'->0->>'player_id')::uuid IS DISTINCT FROM v_id
    OR EXISTS(SELECT FROM players WHERE id=v_other) THEN RAISE EXCEPTION 'Compatible index merge failed'; END IF;
  INSERT INTO players(first_name,last_name,espn_id) VALUES('Conflicting',v_tag,v_tag||'-different-espn') RETURNING id INTO v_other;
  SELECT to_jsonb(p) INTO v_original FROM players p WHERE id=v_id;
  BEGIN
    PERFORM merge_players(v_id,v_other);
    RAISE EXCEPTION 'Conflicting ESPN identities merged';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF NOT EXISTS(SELECT FROM players WHERE id=v_other AND espn_id=v_tag||'-different-espn')
    OR (SELECT to_jsonb(p) FROM players p WHERE id=v_id) IS DISTINCT FROM v_original THEN
    RAISE EXCEPTION 'Conflicting merge altered provider state';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('display_name','Draft'||i||' '||v_tag,'nba_draft_number',i) ORDER BY i)
    INTO v_board FROM generate_series(1,50) i;
  SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) INTO v_before FROM players p;
  BEGIN
    PERFORM resolve_player_imports_atomic('nba_draft', jsonb_set(v_board,'{49,display_name}',to_jsonb('Draft1 '||v_tag)));
    RAISE EXCEPTION 'Two draft picks resolved to one player';
  EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) INTO v_after FROM players p;
  IF v_before IS DISTINCT FROM v_after THEN RAISE EXCEPTION 'Failed draft board partially changed players'; END IF;
  v_result := resolve_player_imports_atomic('nba_draft',v_board);
  SELECT count(*) INTO v_count FROM players WHERE nba_draft_number IS NOT NULL;
  IF v_count <> 50 OR jsonb_array_length(v_result->'results') <> 50
    OR (v_result->>'stale_draft_numbers_cleared')::int < 1 THEN RAISE EXCEPTION 'Complete draft replacement failed'; END IF;
  v_result := resolve_player_imports_atomic('nba_draft',v_board);
  IF EXISTS(SELECT FROM jsonb_array_elements(v_result->'results') r WHERE r->>'action' <> 'updated')
    OR (v_result->>'stale_draft_numbers_cleared')::int <> 0 THEN RAISE EXCEPTION 'Draft replay inserted or cleared again'; END IF;
  RAISE NOTICE 'Actual service role: provider matching, metadata, conflicts, index merge, draft rollback/replay PASS';
END $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.resolve_player_imports_atomic('espn','[]');
    RAISE EXCEPTION 'Anonymous import accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  BEGIN PERFORM public.resolve_player_imports_atomic('nba_cdn','[]');
    RAISE EXCEPTION 'Authenticated import accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE v_name text := 'Mononym'||replace(gen_random_uuid()::text,'-',''); v_first uuid; v_second uuid;
BEGIN
 v_first := (resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object('provider_id',v_name||'-nba','display_name',v_name)))->'results'->0->>'player_id')::uuid;
 v_second := (resolve_player_imports_atomic('espn',jsonb_build_array(jsonb_build_object('provider_id',v_name||'-espn','first_name',v_name,'last_name','',
  'metadata',jsonb_build_object('position','C','eligible_positions',ARRAY['C'],'nba_team','BOS','status','ACT','injury_status',NULL,'years_exp',2))))->'results'->0->>'player_id')::uuid;
 RAISE NOTICE 'Actual identities: %', (SELECT jsonb_agg(jsonb_build_object('id',id,'name',display_name,'nba',nba_id,'espn',espn_id)) FROM players WHERE id IN(v_first,v_second));
 IF v_first <> v_second THEN RAISE EXCEPTION 'Single-word first imports split one provider name into two UUIDs'; END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_user uuid:=gen_random_uuid(); v_league uuid:=gen_random_uuid(); v_winner uuid:=gen_random_uuid(); v_loser uuid:=gen_random_uuid(); v_news uuid:=gen_random_uuid(); v_activity uuid:=gen_random_uuid();
BEGIN
 INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
 VALUES(v_user,'authenticated','authenticated',v_user||'@example.test','x',now(),'{}','{}',now(),now());
 INSERT INTO leagues(id,name,slug,commissioner_id) VALUES(v_league,'Synthetic Merge Links',v_league::text,v_user);
 INSERT INTO players(id,first_name,last_name,nba_id,espn_id) VALUES(v_winner,'Canonical',v_winner::text,v_winner::text,NULL),(v_loser,'Canonical',v_loser::text,NULL,v_loser::text);
 INSERT INTO dynasty_news(id,title,summary,source,player_id) VALUES(v_news,'Synthetic article','Synthetic summary','Synthetic source',v_loser);
 INSERT INTO league_activity(id,league_id,event_type,title,related_player_id) VALUES(v_activity,v_league,'player_added','Synthetic original activity',v_loser);
 PERFORM assign_player_nba_id_atomic(v_loser,v_winner::text);
 RAISE NOTICE 'Actual optional refs: news %, activity %', (SELECT player_id FROM dynasty_news WHERE id=v_news), (SELECT related_player_id FROM league_activity WHERE id=v_activity);
 IF (SELECT player_id FROM dynasty_news WHERE id=v_news) IS DISTINCT FROM v_winner
  OR (SELECT related_player_id FROM league_activity WHERE id=v_activity) IS DISTINCT FROM v_winner THEN
   RAISE EXCEPTION 'Identity merge cleared existing player links'; END IF;
END $$;
ROLLBACK;
