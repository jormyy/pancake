CREATE INDEX IF NOT EXISTS idx_players_identity_name
ON public.players (regexp_replace(lower(regexp_replace(normalize(display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g'));

CREATE OR REPLACE FUNCTION public.link_player_sources_atomic(p_source text,p_records jsonb,p_current_roster boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record jsonb; v_player public.players%ROWTYPE; v_ids uuid[]; v_id uuid; v_source_id text;
  v_name text; v_name_key text; v_team text; v_action text; v_results jsonb:='[]'; v_index integer:=0; v_count integer;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('espn','nba','sleeper') OR jsonb_typeof(p_records) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_records)>500 OR (p_current_roster AND p_source='sleeper') THEN
    RAISE EXCEPTION 'Invalid player source records.' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(p_records) r GROUP BY r->>'provider_id' HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Source identities must be unique.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1347174745,1);
  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    v_source_id:=nullif(btrim(v_record->>'provider_id'),'');
    v_name:=nullif(btrim(v_record->>'display_name'),'');
    v_name_key:=private.player_identity_name(v_name);
    v_team:=private.player_identity_team(v_record->>'nba_team');
    IF v_source_id IS NULL OR v_name IS NULL OR v_name_key='' OR v_team IS NULL OR v_team='' OR
      (v_record->>'years_exp' IS NOT NULL AND v_record->>'years_exp' !~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'Source identity, name and team are required.' USING ERRCODE='22023';
    END IF;
    v_id:=NULL; v_action:='updated';
    SELECT p.id INTO v_id FROM public.players p WHERE CASE p_source
      WHEN 'espn' THEN p.espn_id WHEN 'nba' THEN p.nba_id ELSE p.sleeper_id END=v_source_id FOR UPDATE;
    IF p_source IN ('espn','sleeper') AND v_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.players p WHERE p.id=v_id
        AND private.player_import_name_key(p.display_name) IS DISTINCT FROM private.player_import_name_key(v_name)
        AND private.player_identity_name(p.display_name) IS DISTINCT FROM private.player_identity_name(v_name)
    ) THEN v_id:=NULL; v_action:='ambiguous'; END IF;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_player FROM public.players WHERE id=v_id FOR UPDATE;
      SELECT array_agg(p.id ORDER BY p.id) INTO v_ids FROM public.players p
        WHERE p.id<>v_id AND regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key
          AND private.player_identity_team(p.nba_team)=v_team
          AND CASE p_source WHEN 'espn' THEN p.espn_id WHEN 'nba' THEN p.nba_id ELSE p.sleeper_id END IS NULL
          AND (p.espn_id IS NULL OR v_player.espn_id IS NULL OR p.espn_id=v_player.espn_id)
          AND (p.nba_id IS NULL OR v_player.nba_id IS NULL OR p.nba_id=v_player.nba_id)
          AND (p.sleeper_id IS NULL OR v_player.sleeper_id IS NULL OR p.sleeper_id=v_player.sleeper_id)
          AND (p.sportsdata_id IS NULL OR v_player.sportsdata_id IS NULL OR p.sportsdata_id=v_player.sportsdata_id)
          AND (v_record->>'espn_id' IS NULL OR v_player.espn_id IS NULL OR v_player.espn_id=v_record->>'espn_id')
          AND (v_record->>'nba_id' IS NULL OR v_player.nba_id IS NULL OR v_player.nba_id=v_record->>'nba_id')
          AND (v_record->>'sleeper_id' IS NULL OR v_player.sleeper_id IS NULL OR v_player.sleeper_id=v_record->>'sleeper_id')
          AND (v_record->>'espn_id' IS NULL OR p.espn_id IS NULL OR p.espn_id=v_record->>'espn_id')
          AND (v_record->>'nba_id' IS NULL OR p.nba_id IS NULL OR p.nba_id=v_record->>'nba_id')
          AND (v_record->>'sleeper_id' IS NULL OR p.sleeper_id IS NULL OR p.sleeper_id=v_record->>'sleeper_id')
          AND NOT EXISTS(SELECT FROM public.players other WHERE other.id NOT IN (p.id,v_id) AND (
            (v_record->>'espn_id' IS NOT NULL AND other.espn_id=v_record->>'espn_id')
            OR (v_record->>'nba_id' IS NOT NULL AND other.nba_id=v_record->>'nba_id')
            OR (v_record->>'sleeper_id' IS NOT NULL AND other.sleeper_id=v_record->>'sleeper_id')));
      IF cardinality(v_ids)=1 THEN PERFORM public.merge_players(v_id,v_ids[1]);
      ELSIF cardinality(v_ids)>1 OR EXISTS(SELECT FROM public.players p WHERE p.id<>v_id
        AND regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key
        AND private.player_identity_team(p.nba_team)=v_team
        AND CASE p_source WHEN 'espn' THEN p.espn_id WHEN 'nba' THEN p.nba_id ELSE p.sleeper_id END IS NULL)
      THEN v_id:=NULL; v_action:='ambiguous'; END IF;
    END IF;
    IF v_id IS NULL AND v_action<>'ambiguous' THEN
      SELECT array_agg(p.id ORDER BY p.id) INTO v_ids FROM public.players p
        WHERE regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key
          AND private.player_identity_team(p.nba_team)=v_team
          AND CASE p_source WHEN 'espn' THEN p.espn_id WHEN 'nba' THEN p.nba_id ELSE p.sleeper_id END IS NULL
          AND (v_record->>'espn_id' IS NULL OR p.espn_id IS NULL OR p.espn_id=v_record->>'espn_id')
          AND (v_record->>'nba_id' IS NULL OR p.nba_id IS NULL OR p.nba_id=v_record->>'nba_id')
          AND (v_record->>'sleeper_id' IS NULL OR p.sleeper_id IS NULL OR p.sleeper_id=v_record->>'sleeper_id');
      IF cardinality(v_ids)=1 THEN v_id:=v_ids[1];
      ELSIF cardinality(v_ids)>1 THEN v_action:='ambiguous';
      ELSIF EXISTS(SELECT FROM public.players p WHERE regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key
        AND private.player_identity_team(p.nba_team)=v_team) THEN v_action:='ambiguous';
      ELSIF EXISTS(SELECT FROM public.players p WHERE
        (v_record->>'espn_id' IS NOT NULL AND p.espn_id=v_record->>'espn_id')
        OR (v_record->>'nba_id' IS NOT NULL AND p.nba_id=v_record->>'nba_id')
        OR (v_record->>'sleeper_id' IS NOT NULL AND p.sleeper_id=v_record->>'sleeper_id')) THEN v_action:='ambiguous';
      ELSIF p_current_roster THEN
        INSERT INTO public.players(first_name,last_name,nba_team)
          VALUES(split_part(v_name,' ',1),substr(v_name,length(split_part(v_name,' ',1))+2),v_team) RETURNING id INTO v_id;
        v_action:='inserted';
      ELSE v_action:='missing'; END IF;
    END IF;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_player FROM public.players WHERE id=v_id FOR UPDATE;
      IF (v_record->>'espn_id' IS NOT NULL AND v_player.espn_id IS NOT NULL AND v_player.espn_id<>v_record->>'espn_id')
        OR (v_record->>'nba_id' IS NOT NULL AND v_player.nba_id IS NOT NULL AND v_player.nba_id<>v_record->>'nba_id')
        OR (v_record->>'sleeper_id' IS NOT NULL AND v_player.sleeper_id IS NOT NULL AND v_player.sleeper_id<>v_record->>'sleeper_id')
        OR EXISTS(SELECT FROM public.players p WHERE p.id<>v_id AND (
          (v_record->>'espn_id' IS NOT NULL AND p.espn_id=v_record->>'espn_id')
          OR (v_record->>'nba_id' IS NOT NULL AND p.nba_id=v_record->>'nba_id')
          OR (v_record->>'sleeper_id' IS NOT NULL AND p.sleeper_id=v_record->>'sleeper_id'))) THEN
        v_action:='ambiguous'; v_id:=NULL;
      ELSE
        UPDATE public.players SET
          espn_id=coalesce(espn_id,CASE WHEN p_source='espn' THEN v_source_id ELSE v_record->>'espn_id' END),
          nba_id=coalesce(nba_id,CASE WHEN p_source='nba' THEN v_source_id ELSE v_record->>'nba_id' END),
          sleeper_id=coalesce(sleeper_id,CASE WHEN p_source='sleeper' THEN v_source_id ELSE v_record->>'sleeper_id' END),
          years_exp=coalesce(years_exp,(v_record->>'years_exp')::integer),
          position=coalesce(position,(v_record->>'position')::public.nba_position),
          eligible_positions=CASE WHEN cardinality(eligible_positions)=0 AND v_record->>'position' IS NOT NULL
            THEN ARRAY[coalesce(position::text,v_record->>'position')] ELSE eligible_positions END,
          nba_team=CASE WHEN p_current_roster THEN v_team ELSE nba_team END,
          updated_at=clock_timestamp()
        WHERE id=v_id AND (
          CASE p_source WHEN 'espn' THEN espn_id WHEN 'nba' THEN nba_id ELSE sleeper_id END IS NULL
          OR (years_exp IS NULL AND v_record->>'years_exp' IS NOT NULL)
          OR (position IS NULL AND v_record->>'position' IS NOT NULL)
          OR (cardinality(eligible_positions)=0 AND v_record->>'position' IS NOT NULL)
          OR (espn_id IS NULL AND v_record->>'espn_id' IS NOT NULL)
          OR (nba_id IS NULL AND v_record->>'nba_id' IS NOT NULL)
          OR (sleeper_id IS NULL AND v_record->>'sleeper_id' IS NOT NULL)
          OR (p_current_roster AND nba_team IS DISTINCT FROM v_team));
        GET DIAGNOSTICS v_count=ROW_COUNT;
        IF v_count=0 AND v_action<>'inserted' THEN v_action:='unchanged'; END IF;
      END IF;
    END IF;
    v_results:=v_results||jsonb_build_array(jsonb_build_object('index',v_index,'player_id',v_id,'action',v_action));
    v_index:=v_index+1;
  END LOOP;
  RETURN jsonb_build_object('results',v_results);
END;
$$;
