BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
CREATE OR REPLACE FUNCTION public.link_player_sources_atomic(p_source text,p_records jsonb,p_current_roster boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_record jsonb; v_player public.players%ROWTYPE; v_ids uuid[]; v_id uuid; v_source_id text;
  v_name text; v_name_key text; v_team text; v_action text; v_results jsonb:='[]'; v_index integer:=0; v_count integer; v_link_count integer;
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
      WHEN 'espn' THEN p.espn_id WHEN 'nba' THEN p.nba_id ELSE p.sleeper_id END=v_source_id FOR NO KEY UPDATE;
    IF p_source IN ('espn','sleeper') AND v_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.players p WHERE p.id=v_id
        AND private.player_import_name_key(p.display_name) IS DISTINCT FROM private.player_import_name_key(v_name)
        AND private.player_identity_name(p.display_name) IS DISTINCT FROM private.player_identity_name(v_name)
    ) THEN v_id:=NULL; v_action:='ambiguous'; END IF;
    IF v_id IS NOT NULL THEN
      SELECT * INTO v_player FROM public.players WHERE id=v_id FOR NO KEY UPDATE;
      IF private.player_identity_name(v_player.display_name)=v_name_key
        AND (v_record->>'espn_id' IS NULL OR v_player.espn_id=v_record->>'espn_id')
        AND (v_record->>'nba_id' IS NULL OR v_player.nba_id=v_record->>'nba_id')
        AND (v_record->>'sleeper_id' IS NULL OR v_player.sleeper_id=v_record->>'sleeper_id')
        AND (v_record->>'years_exp' IS NULL OR v_player.years_exp IS NOT NULL)
        AND (v_record->>'position' IS NULL OR (v_player.position IS NOT NULL AND cardinality(v_player.eligible_positions)>0))
        AND (NOT p_current_roster OR v_player.nba_team IS NOT DISTINCT FROM v_team)
        AND NOT EXISTS(SELECT FROM public.players p WHERE p.id<>v_id AND (
          (v_record->>'espn_id' IS NOT NULL AND p.espn_id=v_record->>'espn_id')
          OR (v_record->>'nba_id' IS NOT NULL AND p.nba_id=v_record->>'nba_id')
          OR (v_record->>'sleeper_id' IS NOT NULL AND p.sleeper_id=v_record->>'sleeper_id')))
        AND NOT EXISTS(SELECT FROM public.players p WHERE p.id<>v_id
          AND regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key)
      THEN
        UPDATE public.players p SET nba_team=p.nba_team WHERE false;
        v_results:=v_results||jsonb_build_array(jsonb_build_object('index',v_index,'player_id',v_id,'action','unchanged'));
        v_index:=v_index+1;
        CONTINUE;
      END IF;
      SELECT array_agg(p.id ORDER BY p.id) INTO v_ids FROM public.players p
        WHERE p.id<>v_id AND regexp_replace(lower(regexp_replace(normalize(p.display_name,NFD),U&'[\0300-\036F]','','g')),'[^a-z]','','g')=v_name_key
          AND (private.player_identity_team(p.nba_team)=v_team OR (
            p_source='nba' AND p.nba_team IS NULL AND v_player.nba_team IS NULL
            AND v_record->>'espn_id' IS NOT NULL AND v_player.nba_id=v_source_id
            AND private.player_identity_name(v_player.display_name)=v_name_key
            AND p.sleeper_id IS NOT NULL AND v_player.sleeper_id IS NULL
            AND (p.years_exp IS NULL OR v_player.years_exp IS NULL OR p.years_exp=v_player.years_exp)
            AND (SELECT count(*) FROM public.players candidate
              WHERE private.player_identity_name(candidate.display_name)=v_name_key)=2))
          AND (p.birthdate IS NULL OR v_player.birthdate IS NULL OR p.birthdate=v_player.birthdate)
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
      IF cardinality(v_ids)=1 THEN
        UPDATE public.players target SET birthdate=source.birthdate FROM public.players source
          WHERE target.id=v_id AND source.id=v_ids[1] AND target.birthdate IS NULL AND source.birthdate IS NOT NULL;
        PERFORM public.merge_players(v_id,v_ids[1]);
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
      SELECT * INTO v_player FROM public.players WHERE id=v_id FOR NO KEY UPDATE;
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
          updated_at=clock_timestamp()
        WHERE id=v_id AND (
          CASE p_source WHEN 'espn' THEN espn_id WHEN 'nba' THEN nba_id ELSE sleeper_id END IS NULL
          OR (espn_id IS NULL AND v_record->>'espn_id' IS NOT NULL)
          OR (nba_id IS NULL AND v_record->>'nba_id' IS NOT NULL)
          OR (sleeper_id IS NULL AND v_record->>'sleeper_id' IS NOT NULL));
        GET DIAGNOSTICS v_link_count=ROW_COUNT;
        UPDATE public.players SET
          years_exp=coalesce(years_exp,(v_record->>'years_exp')::integer),
          position=coalesce(position,(v_record->>'position')::public.nba_position),
          eligible_positions=CASE WHEN cardinality(eligible_positions)=0 AND v_record->>'position' IS NOT NULL
            THEN ARRAY[coalesce(position::text,v_record->>'position')] ELSE eligible_positions END,
          nba_team=CASE WHEN p_current_roster THEN v_team ELSE nba_team END,
          updated_at=clock_timestamp()
        WHERE id=v_id AND (
          (years_exp IS NULL AND v_record->>'years_exp' IS NOT NULL)
          OR (position IS NULL AND v_record->>'position' IS NOT NULL)
          OR (cardinality(eligible_positions)=0 AND v_record->>'position' IS NOT NULL)
          OR (p_current_roster AND nba_team IS DISTINCT FROM v_team));
        GET DIAGNOSTICS v_count=ROW_COUNT;
        IF v_count+v_link_count=0 AND v_action<>'inserted' THEN v_action:='unchanged'; END IF;
      END IF;
    END IF;
    v_results:=v_results||jsonb_build_array(jsonb_build_object('index',v_index,'player_id',v_id,'action',v_action));
    v_index:=v_index+1;
  END LOOP;
  RETURN jsonb_build_object('results',v_results);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_game_stats_atomic(
  p_game_id uuid,
  p_provider_game_id text,
  p_stats jsonb,
  p_is_final boolean
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_game public.nba_games%ROWTYPE;
  v_changed integer;
  v_year integer;
  v_removed jsonb := '[]'::jsonb;
  v_started_at timestamptz := clock_timestamp();
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id = p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year THEN RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE = 'PT409'; END IF;
  PERFORM public.assert_nba_game_unambiguous(p_game_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM private.game_stat_revisions WHERE game_id=p_game_id)
    AND current_setting('app.verified_stats_game',true) IS DISTINCT FROM p_game_id::text THEN
    RAISE EXCEPTION 'A versioned snapshot is required for verified game data.' USING ERRCODE='PT409';
  END IF;
  IF v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game provider identity changed. Fetch the game again.' USING ERRCODE = 'PT409';
  END IF;
  IF jsonb_typeof(p_stats) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'A complete parsed box score is required.' USING ERRCODE = '22023';
  END IF;
  IF p_is_final AND jsonb_array_length(p_stats) = 0 THEN
    RAISE EXCEPTION 'A Final box score must contain resolved players.' USING ERRCODE = '22023';
  END IF;
  IF p_is_final IS NULL OR (v_game.status = 'Final' AND NOT p_is_final) THEN
    RAISE EXCEPTION 'Final game box score is not final.' USING ERRCODE = '22023';
  END IF;
  IF NOT p_is_final AND jsonb_array_length(p_stats) = 0 THEN RETURN 0; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS row
    WHERE row.player_id IS NULL OR row.game_id IS DISTINCT FROM p_game_id
       OR row.did_not_play IS NULL
  ) OR (SELECT count(DISTINCT (row->>'player_id')::uuid) FROM jsonb_array_elements(p_stats) AS row) <> jsonb_array_length(p_stats) THEN
    RAISE EXCEPTION 'Box score rows do not match the current game or contain duplicate players.' USING ERRCODE = '22023';
  END IF;

  IF p_is_final THEN
    WITH removed AS (
      DELETE FROM public.player_game_stats AS stored
      WHERE stored.game_id = p_game_id
        AND stored.did_not_play
        AND ROW(stored.minutes_played, stored.points, stored.rebounds, stored.offensive_rebounds,
          stored.defensive_rebounds, stored.assists, stored.steals, stored.blocks, stored.turnovers,
          stored.personal_fouls, stored.field_goals_made, stored.field_goals_attempted,
          stored.three_pointers_made, stored.three_pointers_attempted, stored.free_throws_made,
          stored.free_throws_attempted, stored.plus_minus, stored.double_double, stored.triple_double)
          IS NOT DISTINCT FROM ROW(0::numeric, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, false)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_stats) AS row WHERE (row->>'player_id')::uuid = stored.player_id)
      RETURNING stored.*
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(removed) ORDER BY player_id), '[]'::jsonb) INTO v_removed FROM removed;
  END IF;

  IF p_is_final AND EXISTS (
    SELECT 1 FROM public.player_game_stats AS stored
    WHERE stored.game_id = p_game_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_stats) AS row WHERE (row->>'player_id')::uuid = stored.player_id)
  ) THEN
    RAISE EXCEPTION 'The complete box score omits stored players. Resolve the game inputs before certifying it.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.player_game_stats AS stored (
    player_id, game_id, is_home, season_year, week_number, minutes_played, points, rebounds, offensive_rebounds, defensive_rebounds, assists, steals, blocks, turnovers, personal_fouls, field_goals_made, field_goals_attempted, three_pointers_made, three_pointers_attempted, free_throws_made, free_throws_attempted, plus_minus, double_double, triple_double, did_not_play, updated_at
  )
  SELECT incoming.player_id, v_game.id, incoming.is_home, v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play, clock_timestamp()
  FROM jsonb_populate_recordset(NULL::public.player_game_stats, p_stats) AS incoming
  LEFT JOIN public.player_game_stats previous ON previous.player_id=incoming.player_id AND previous.game_id=v_game.id
  WHERE previous.player_id IS NULL OR ROW(previous.player_id, previous.game_id, previous.is_home, previous.season_year, previous.week_number, previous.minutes_played, previous.points, previous.rebounds, previous.offensive_rebounds, previous.defensive_rebounds, previous.assists, previous.steals, previous.blocks, previous.turnovers, previous.personal_fouls, previous.field_goals_made, previous.field_goals_attempted, previous.three_pointers_made, previous.three_pointers_attempted, previous.free_throws_made, previous.free_throws_attempted, previous.plus_minus, previous.double_double, previous.triple_double, previous.did_not_play)
    IS DISTINCT FROM ROW(incoming.player_id, v_game.id, COALESCE(incoming.is_home, previous.is_home), v_game.season_year, v_game.week_number, incoming.minutes_played, incoming.points, incoming.rebounds, incoming.offensive_rebounds, incoming.defensive_rebounds, incoming.assists, incoming.steals, incoming.blocks, incoming.turnovers, incoming.personal_fouls, incoming.field_goals_made, incoming.field_goals_attempted, incoming.three_pointers_made, incoming.three_pointers_attempted, incoming.free_throws_made, incoming.free_throws_attempted, incoming.plus_minus, incoming.double_double, incoming.triple_double, incoming.did_not_play)
  ON CONFLICT (player_id, game_id) DO UPDATE SET
    is_home = COALESCE(EXCLUDED.is_home, stored.is_home),
    season_year = EXCLUDED.season_year,
    week_number = EXCLUDED.week_number,
    minutes_played = EXCLUDED.minutes_played,
    points = EXCLUDED.points,
    rebounds = EXCLUDED.rebounds,
    offensive_rebounds = EXCLUDED.offensive_rebounds,
    defensive_rebounds = EXCLUDED.defensive_rebounds,
    assists = EXCLUDED.assists,
    steals = EXCLUDED.steals,
    blocks = EXCLUDED.blocks,
    turnovers = EXCLUDED.turnovers,
    personal_fouls = EXCLUDED.personal_fouls,
    field_goals_made = EXCLUDED.field_goals_made,
    field_goals_attempted = EXCLUDED.field_goals_attempted,
    three_pointers_made = EXCLUDED.three_pointers_made,
    three_pointers_attempted = EXCLUDED.three_pointers_attempted,
    free_throws_made = EXCLUDED.free_throws_made,
    free_throws_attempted = EXCLUDED.free_throws_attempted,
    plus_minus = EXCLUDED.plus_minus,
    double_double = EXCLUDED.double_double,
    triple_double = EXCLUDED.triple_double,
    did_not_play = EXCLUDED.did_not_play,
    updated_at = EXCLUDED.updated_at
  WHERE ROW(stored.player_id, stored.game_id, stored.is_home, stored.season_year, stored.week_number, stored.minutes_played, stored.points, stored.rebounds, stored.offensive_rebounds, stored.defensive_rebounds, stored.assists, stored.steals, stored.blocks, stored.turnovers, stored.personal_fouls, stored.field_goals_made, stored.field_goals_attempted, stored.three_pointers_made, stored.three_pointers_attempted, stored.free_throws_made, stored.free_throws_attempted, stored.plus_minus, stored.double_double, stored.triple_double, stored.did_not_play)
    IS DISTINCT FROM ROW(EXCLUDED.player_id, EXCLUDED.game_id, COALESCE(EXCLUDED.is_home, stored.is_home), EXCLUDED.season_year, EXCLUDED.week_number, EXCLUDED.minutes_played, EXCLUDED.points, EXCLUDED.rebounds, EXCLUDED.offensive_rebounds, EXCLUDED.defensive_rebounds, EXCLUDED.assists, EXCLUDED.steals, EXCLUDED.blocks, EXCLUDED.turnovers, EXCLUDED.personal_fouls, EXCLUDED.field_goals_made, EXCLUDED.field_goals_attempted, EXCLUDED.three_pointers_made, EXCLUDED.three_pointers_attempted, EXCLUDED.free_throws_made, EXCLUDED.free_throws_attempted, EXCLUDED.plus_minus, EXCLUDED.double_double, EXCLUDED.triple_double, EXCLUDED.did_not_play);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF p_is_final THEN
    UPDATE public.nba_games SET stats_synced_at = clock_timestamp(), status = 'Final',
      updated_at = CASE WHEN status <> 'Final' THEN clock_timestamp() ELSE updated_at END
    WHERE id = p_game_id;
  ELSE
    UPDATE public.nba_games SET stats_synced_at = NULL WHERE id = p_game_id AND stats_synced_at IS NOT NULL;
  END IF;
  IF jsonb_array_length(v_removed) > 0 THEN
    INSERT INTO public.sync_runs(function_name, started_at, finished_at, status, rows_affected, details)
    VALUES('sync-stats:inactive-cleanup', v_started_at, clock_timestamp(), 'success', jsonb_array_length(v_removed),
      jsonb_build_object('game_id', p_game_id, 'nba_game_id', p_provider_game_id, 'removed_inactive_rows', v_removed));
  END IF;
  RETURN v_changed;
END;
$$;

-- Resolve absence and provider ownership under the same lock as identity merges; an ESPN omission moves a team only when his latest stored box after he was last placed there (by ESPN's listing or a stored box under that team) is of a game his team did not play (to the side that box lists him under, else to no team), and every other omitted row is held; a box player that no NBA id or name joins links to the one ESPN row on his box side whose name has the same words, only on corroborated evidence.
CREATE OR REPLACE FUNCTION public.resolve_player_imports_atomic(p_source text, p_records jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, private
AS $$
DECLARE
  v_record jsonb;
  v_metadata jsonb;
  v_allowed text[];
  v_provider text;
  v_name text;
  v_first text;
  v_last text;
  v_id uuid;
  v_game_id uuid;
  v_row players%ROWTYPE;
  v_matches uuid[];
  v_ids uuid[] := '{}';
  v_results jsonb := '[]';
  v_action text;
  v_pick int;
  v_cleared int := 0;
  v_index int := 0;
  v_providers text[];
  v_name_keys text[];
  v_player_ids uuid[];
  v_released uuid[];
  v_words text[];
  v_link uuid;
  v_linked text;
  v_team text;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('espn', 'espn_release', 'sleeper', 'nba_cdn', 'nba_index', 'nba_draft')
     OR p_records IS NULL OR jsonb_typeof(p_records) <> 'array'
     OR jsonb_array_length(p_records) > (CASE WHEN p_source = 'espn_release' THEN 1000 ELSE 500 END) THEN
    RAISE EXCEPTION 'Invalid player import source or records.' USING ERRCODE = '22023';
  END IF;
  IF p_source = 'espn_release' AND jsonb_array_length(p_records) < 350 THEN
    RAISE EXCEPTION 'A release needs the complete ESPN listing.' USING ERRCODE = '22023';
  END IF;
  IF p_source = 'nba_draft' AND jsonb_array_length(p_records) NOT BETWEEN 50 AND 60 THEN
    RAISE EXCEPTION 'A complete NBA draft board requires 50 to 60 picks.' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_records) r WHERE jsonb_typeof(r) <> 'object') THEN
    RAISE EXCEPTION 'Player import records must be objects.' USING ERRCODE = '22023';
  END IF;
  IF p_source <> 'nba_draft' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) r
    GROUP BY r->>'provider_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Provider identities must be unique within an import.' USING ERRCODE = '22023';
  END IF;
  IF p_source = 'nba_draft' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) r
    GROUP BY r->>'nba_draft_number' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'NBA draft picks must be unique.' USING ERRCODE = '22023';
  END IF;

  IF p_source = 'nba_cdn' AND EXISTS (SELECT FROM jsonb_array_elements(p_records) r WHERE r ? 'identity_only') THEN
    IF EXISTS (SELECT FROM jsonb_array_elements(p_records) r
      WHERE r->'identity_only' IS DISTINCT FROM 'true'::jsonb
        OR jsonb_typeof(r->'provider_id') IS DISTINCT FROM 'string' OR btrim(r->>'provider_id') = ''
        OR jsonb_typeof(r->'display_name') IS DISTINCT FROM 'string'
        OR private.player_import_name_key(r->>'display_name') = ''
        OR EXISTS (SELECT FROM jsonb_object_keys(r) k WHERE NOT k = ANY(
          ARRAY['provider_id','display_name','nba_game_id','nba_team','metadata','identity_only']))) THEN
      RAISE EXCEPTION 'Invalid stat player identity.' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS(SELECT FROM jsonb_array_elements(p_records) r
      WHERE r->>'provider_id' IN ('196295686','1641794')
        OR jsonb_typeof(r->'nba_game_id') IS DISTINCT FROM 'string'
        OR jsonb_typeof(r->'nba_team') IS DISTINCT FROM 'string'
        OR btrim(r->>'nba_team')=''
        OR private.player_identity_team(r->>'nba_team') IS NULL
        OR CASE WHEN jsonb_typeof(coalesce(r->'metadata','{}'::jsonb))='object' THEN
          EXISTS(SELECT FROM jsonb_object_keys(coalesce(r->'metadata','{}'::jsonb)) k WHERE NOT k=ANY(ARRAY['position','years_exp']))
          ELSE true END) THEN
      WITH incoming AS MATERIALIZED (
        SELECT value AS record,ordinality-1 AS index,private.player_identity_team(value->>'nba_team') AS nba_team
        FROM jsonb_array_elements(p_records) WITH ORDINALITY)
      SELECT jsonb_agg(jsonb_build_object('index',incoming.index,'player_id',p.id,'action','updated') ORDER BY incoming.index)
      INTO v_record
      FROM incoming JOIN public.players p ON p.nba_id=incoming.record->>'provider_id'
      JOIN public.nba_games g ON g.nba_game_id=incoming.record->>'nba_game_id'
      JOIN private.player_game_memberships m ON m.player_id=p.id AND m.game_id=g.id
        AND m.nba_team IS NOT DISTINCT FROM incoming.nba_team
      HAVING count(*)=jsonb_array_length(p_records) AND count(DISTINCT p.id)=jsonb_array_length(p_records);
      IF v_record IS NOT NULL THEN
        UPDATE private.player_game_memberships m SET nba_team=m.nba_team WHERE false;
        RETURN jsonb_build_object('results',v_record,'stale_draft_numbers_cleared',0);
      END IF;
    END IF;
    FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) LOOP
      v_provider := v_record->>'provider_id';
      v_name := btrim(v_record->>'display_name');
      v_metadata := coalesce(v_record->'metadata','{}'::jsonb);
      IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' OR EXISTS (
        SELECT FROM jsonb_object_keys(v_metadata) k WHERE NOT k = ANY(ARRAY['position','years_exp'])) THEN
        RAISE EXCEPTION 'Unsupported stat player metadata.' USING ERRCODE = '22023';
      END IF;
      v_game_id := NULL;
      IF v_record ? 'nba_game_id' THEN
        IF jsonb_typeof(v_record->'nba_game_id') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Invalid NBA game identity.' USING ERRCODE = '22023';
        END IF;
        SELECT id INTO v_game_id FROM public.nba_games WHERE nba_game_id=v_record->>'nba_game_id';
        IF NOT FOUND THEN RAISE EXCEPTION 'Unknown NBA game identity.' USING ERRCODE = '22023'; END IF;
      END IF;
      IF v_record ? 'nba_team' AND (v_game_id IS NULL OR jsonb_typeof(v_record->'nba_team') IS DISTINCT FROM 'string'
        OR private.player_identity_team(v_record->>'nba_team') IS NULL OR btrim(v_record->>'nba_team')='') THEN
        RAISE EXCEPTION 'A box side needs its NBA game and a team code.' USING ERRCODE = '22023';
      END IF;
      IF v_provider='196295686' AND lower(v_name)<>'dillon jones' THEN
        RAISE EXCEPTION 'Unexpected name for NBA CDN identity %: %',v_provider,v_name USING ERRCODE='23514';
      END IF;
      IF v_provider IN ('196295686','1641794') AND lower(v_name)='dillon jones' THEN v_provider:='1641794'; END IF;
      SELECT id INTO v_id FROM public.players WHERE nba_id=v_provider;
      IF v_id IS NULL AND v_provider='1641794' AND lower(v_name)='dillon jones' THEN
        SELECT id INTO v_id FROM public.players WHERE nba_id='196295686' AND lower(btrim(display_name))='dillon jones';
      END IF;
      v_action:='updated';
      IF v_id IS NULL THEN
        BEGIN
          INSERT INTO public.players(first_name,last_name,nba_id,position,eligible_positions,years_exp)
          VALUES(split_part(v_name,' ',1),substr(v_name,length(split_part(v_name,' ',1))+2),v_provider,
            (v_metadata->>'position')::public.nba_position,
            CASE WHEN v_metadata->>'position' IS NULL THEN '{}'::text[] ELSE ARRAY[v_metadata->>'position'] END,
            (v_metadata->>'years_exp')::integer)
          RETURNING id INTO v_id;
          v_action:='inserted';
        EXCEPTION WHEN unique_violation THEN
          SELECT id INTO v_id FROM public.players WHERE nba_id=v_provider;
          IF v_id IS NULL THEN RAISE; END IF;
        END;
      END IF;
      IF v_id=ANY(v_ids) THEN RAISE EXCEPTION 'Duplicate stat player identity.' USING ERRCODE='22023'; END IF;
      v_ids:=array_append(v_ids,v_id);
      IF v_game_id IS NOT NULL AND v_record ? 'nba_team' THEN
        INSERT INTO private.player_game_memberships(player_id,game_id,nba_team)
        VALUES(v_id,v_game_id,private.player_identity_team(v_record->>'nba_team'))
        ON CONFLICT(player_id,game_id) DO UPDATE SET nba_team=EXCLUDED.nba_team
        WHERE player_game_memberships.nba_team IS DISTINCT FROM EXCLUDED.nba_team;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('index',v_index,'player_id',v_id,'action',v_action));
      v_index:=v_index+1;
    END LOOP;
    RETURN jsonb_build_object('results',v_results,'stale_draft_numbers_cleared',0);
  END IF;

  -- Acquire before any name/provider read or player row lock. A subsequent
  -- READ COMMITTED statement sees the importer that just released this lock.
  PERFORM pg_advisory_xact_lock(1347174745, 1);

  -- espn_release carries every player of a structurally complete ESPN refresh (every team, every record
  -- imported). Structure is not proof of completeness: a roster page can answer 200 and still omit a
  -- signed player, and nothing in the payload tells that apart from a release. An omission in the stored
  -- NBA boxes is no proof either: real boxes omit signed players for a game or for months whatever their
  -- last listing showed (playing, inactive, DNP) or when no box has listed them yet. No feed the product
  -- reads states that a player is no longer rostered. So an omission alone clears no team. The one
  -- positive evidence the store holds is a box row or game membership in a game his team did not play: he
  -- was on one of the two teams in it. It counts when it is his latest stored listing in a regular-season,
  -- playoff, play-in or Cup final game (All-Star and preseason games have teams that are not NBA teams)
  -- and tipped off after he was last placed on his team: ESPN's latest listing of him there
  -- (player_espn_listings) or his latest stored box under that team, whichever is later, so a box that
  -- moved him there anchors his next move as a listing would. A later box of a game his own team played
  -- wins, and so does a later placement. Without a placement he is held. A box lists him under his side,
  -- which his game membership keeps (nba_cdn nba_team): he moves to that team, so he stays startable on its
  -- game days until ESPN lists him. A stats row or membership without a side, or a side that is not a
  -- team of that game, clears his team and the next listing that names him sets the new one. His team must
  -- play under that code in that season, so a code that matches no game cannot pass for a departure.
  -- Every other omitted teamed row is held and reported, unproven if ESPN claimed it (espn_id) and
  -- unclaimed if not. A listed player who resolved to no row (an ambiguous name) could be any row with
  -- that name, so those rows are not candidates.
  IF p_source = 'espn_release' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_records) AS r
      WHERE jsonb_typeof(r->'provider_id') IS DISTINCT FROM 'string' OR btrim(r->>'provider_id') = ''
        OR jsonb_typeof(r->'first_name') IS DISTINCT FROM 'string' OR jsonb_typeof(r->'last_name') IS DISTINCT FROM 'string'
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(r) AS k WHERE NOT k = ANY(ARRAY['provider_id', 'first_name', 'last_name']))) THEN
      RAISE EXCEPTION 'Unsupported player import field.' USING ERRCODE = '22023';
    END IF;
    SELECT array_agg(r->>'provider_id'),
      coalesce(array_agg(private.player_import_name_key(concat_ws(' ', r->>'first_name', r->>'last_name')))
        FILTER (WHERE p.id IS NULL), '{}')
      INTO v_providers, v_name_keys
      FROM jsonb_array_elements(p_records) AS r
      LEFT JOIN players AS p ON p.espn_id = r->>'provider_id';
    SELECT coalesce(array_agg(p.id ORDER BY p.id), '{}') INTO v_player_ids FROM players AS p
      WHERE p.nba_team IS NOT NULL AND (p.espn_id IS NULL OR NOT p.espn_id = ANY(v_providers))
        AND NOT coalesce(private.player_import_name_key(p.display_name) = ANY(v_name_keys), false);
    PERFORM p.id FROM players AS p WHERE p.id = ANY(v_player_ids) ORDER BY p.id FOR UPDATE;
    WITH released AS (
      UPDATE players AS p SET nba_team = evidence.side, updated_at = clock_timestamp()
      FROM (SELECT c.id, e.departed, e.side FROM players AS c CROSS JOIN LATERAL (
          SELECT c.nba_team NOT IN (g.home_team, g.away_team) AND EXISTS (SELECT 1 FROM nba_games AS own
              WHERE own.season_year = g.season_year AND c.nba_team IN (own.home_team, own.away_team)) AS departed,
            CASE WHEN side.nba_team IN (g.home_team, g.away_team) THEN side.nba_team END AS side
          FROM (SELECT max(placement.placed_at) AS placed_at FROM (
                SELECT l.listed_at AS placed_at FROM player_espn_listings AS l WHERE l.player_id = c.id AND l.nba_team = c.nba_team
                UNION ALL SELECT coalesce(box_game.game_time, box_game.started_at) FROM private.player_game_memberships AS m
                  JOIN nba_games AS box_game ON box_game.id = m.game_id
                  WHERE m.player_id = c.id AND m.nba_team = c.nba_team AND box_game.nba_game_id ~ '^00[2456]') AS placement) AS anchor
          JOIN (SELECT s.game_id FROM player_game_stats AS s WHERE s.player_id = c.id
                UNION SELECT m.game_id FROM private.player_game_memberships AS m WHERE m.player_id = c.id) AS listed ON true
          JOIN nba_games AS g ON g.id = listed.game_id
          LEFT JOIN private.player_game_memberships AS side ON side.player_id = c.id AND side.game_id = g.id
          WHERE g.nba_game_id ~ '^00[2456]' AND coalesce(g.game_time, g.started_at) > anchor.placed_at
          ORDER BY coalesce(g.game_time, g.started_at) DESC, c.nba_team IN (g.home_team, g.away_team) DESC
          LIMIT 1) AS e
        WHERE c.id = ANY(v_player_ids)) AS evidence
      WHERE p.id = evidence.id AND evidence.departed
      RETURNING p.id)
    SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_released FROM released;
    RETURN jsonb_build_object('released', to_jsonb(v_released), 'held', (
      SELECT jsonb_build_object(
        'unproven', coalesce(jsonb_agg(p.id ORDER BY p.id) FILTER (WHERE p.espn_id IS NOT NULL), '[]'),
        'unclaimed', coalesce(jsonb_agg(p.id ORDER BY p.id) FILTER (WHERE p.espn_id IS NULL), '[]'))
      FROM players AS p WHERE p.id = ANY(v_player_ids) AND NOT p.id = ANY(v_released) AND p.nba_team IS NOT NULL));
  END IF;

  IF p_source = 'nba_cdn' THEN
    PERFORM g.id FROM nba_games AS g
      WHERE g.nba_game_id IN (SELECT r->>'nba_game_id' FROM jsonb_array_elements(p_records) AS r)
      ORDER BY g.id FOR KEY SHARE;
  END IF;
  SELECT array_agg(r->>'provider_id'),
    array_agg(private.player_import_name_key(CASE
      WHEN p_source IN ('espn', 'sleeper') THEN concat_ws(' ', r->>'first_name', r->>'last_name')
      WHEN p_source = 'nba_index' THEN r->>'expected_display_name'
      ELSE r->>'display_name' END)),
    array_agg(CASE WHEN p_source = 'nba_index' THEN (r->>'player_id')::uuid END)
    INTO v_providers, v_name_keys, v_player_ids
    FROM jsonb_array_elements(p_records) AS r;
  PERFORM p.id FROM players AS p
    WHERE (p_source = 'espn' AND p.espn_id = ANY(v_providers))
      OR (p_source = 'sleeper' AND p.sleeper_id = ANY(v_providers))
      OR (p_source IN ('nba_cdn', 'nba_index') AND p.nba_id = ANY(v_providers))
      OR p.id = ANY(v_player_ids)
      OR private.player_import_name_key(p.display_name) = ANY(v_name_keys)
      OR private.player_identity_name(p.display_name) = ANY(ARRAY(SELECT private.player_identity_name(k) FROM unnest(v_name_keys) k))
      OR (p_source = 'nba_draft' AND p.nba_draft_number IS NOT NULL)
    ORDER BY p.id FOR UPDATE;
  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    v_index := v_index + 1;
    v_metadata := coalesce(v_record->'metadata', '{}'::jsonb);
    v_allowed := CASE WHEN p_source IN ('espn', 'sleeper')
      THEN ARRAY['nba_team', 'position', 'eligible_positions', 'status', 'injury_status', 'years_exp', 'birthdate']
      WHEN p_source='nba_cdn' THEN ARRAY['position','years_exp'] ELSE ARRAY[]::text[] END;
    IF jsonb_typeof(v_metadata) <> 'object' THEN
      RAISE EXCEPTION 'Player metadata must be an object.' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_metadata) k WHERE NOT k = ANY(v_allowed))
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_record) k WHERE NOT k = ANY(
        CASE WHEN p_source = 'nba_index' THEN ARRAY['provider_id', 'player_id', 'expected_display_name', 'name_match', 'metadata']
        WHEN p_source = 'nba_draft' THEN ARRAY['display_name', 'nba_draft_number', 'metadata']
        WHEN p_source = 'nba_cdn' THEN ARRAY['provider_id', 'display_name', 'metadata', 'nba_game_id', 'nba_team']
        ELSE ARRAY['provider_id', 'first_name', 'last_name', 'metadata'] END)) THEN
      RAISE EXCEPTION 'Unsupported player import field.' USING ERRCODE = '22023';
    END IF;
    v_provider := v_record->>'provider_id';
    IF p_source <> 'nba_draft' AND (jsonb_typeof(v_record->'provider_id') IS DISTINCT FROM 'string'
        OR btrim(v_provider) = '') THEN
      RAISE EXCEPTION 'Provider identity is required.' USING ERRCODE = '22023';
    END IF;
    v_game_id := NULL;
    IF p_source = 'nba_cdn' AND v_record ? 'nba_game_id' THEN
      IF jsonb_typeof(v_record->'nba_game_id') IS DISTINCT FROM 'string'
        OR btrim(v_record->>'nba_game_id') = '' THEN
        RAISE EXCEPTION 'NBA game identity is required.' USING ERRCODE = '22023';
      END IF;
      SELECT id INTO v_game_id FROM nba_games
        WHERE nba_game_id = v_record->>'nba_game_id' FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown NBA game identity.' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF p_source = 'nba_cdn' AND v_record ? 'nba_team' AND (v_game_id IS NULL
        OR jsonb_typeof(v_record->'nba_team') IS DISTINCT FROM 'string' OR btrim(v_record->>'nba_team') = '') THEN
      RAISE EXCEPTION 'A box side needs its NBA game and a team code.' USING ERRCODE = '22023';
    END IF;
    v_team := private.player_identity_team(CASE WHEN p_source = 'nba_cdn' THEN v_record->>'nba_team' ELSE v_metadata->>'nba_team' END);
    v_id := NULL;
    v_action := 'updated';
    v_linked := NULL;

    IF p_source = 'nba_index' THEN
      IF jsonb_typeof(v_record->'expected_display_name') IS DISTINCT FROM 'string'
        OR coalesce(v_record->>'name_match', '') NOT IN ('exact', 'normalized') THEN
        RAISE EXCEPTION 'NBA index requires the expected name and match method.' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_row FROM players WHERE id = (v_record->>'player_id')::uuid FOR UPDATE;
      IF NOT FOUND THEN
        v_action := 'missing';
      ELSIF v_row.display_name IS DISTINCT FROM v_record->>'expected_display_name' THEN
        v_action := 'stale';
      ELSE
        SELECT array_agg(id) INTO v_matches FROM players
        WHERE CASE WHEN v_record->>'name_match' = 'exact'
          THEN lower(display_name) = lower(v_row.display_name)
          ELSE private.player_import_name_key(display_name) = private.player_import_name_key(v_row.display_name) END;
        IF cardinality(v_matches) <> 1 THEN
          v_action := 'ambiguous';
        ELSE
          v_id := public.assign_player_nba_id_atomic(v_row.id, v_provider);
        END IF;
      END IF;
    ELSE
      IF p_source IN ('espn', 'sleeper') THEN
        IF jsonb_typeof(v_record->'first_name') IS DISTINCT FROM 'string'
          OR jsonb_typeof(v_record->'last_name') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Player names must be strings.' USING ERRCODE = '22023';
        END IF;
        v_first := v_record->>'first_name';
        v_last := v_record->>'last_name';
        v_name := concat_ws(' ', nullif(v_first, ''), nullif(v_last, ''));
      ELSE
        IF jsonb_typeof(v_record->'display_name') IS DISTINCT FROM 'string' THEN
          RAISE EXCEPTION 'Player display name is required.' USING ERRCODE = '22023';
        END IF;
        v_name := v_record->>'display_name';
        v_first := split_part(btrim(v_name), ' ', 1);
        v_last := substr(btrim(v_name), length(v_first) + 2);
      END IF;
      IF private.player_import_name_key(v_name) = '' THEN
        RAISE EXCEPTION 'Player name is empty.' USING ERRCODE = '22023';
      END IF;
      IF p_source = 'nba_cdn' AND v_provider IN ('196295686', '1641794') THEN
        IF v_provider = '196295686' AND lower(btrim(v_name)) <> 'dillon jones' THEN
          RAISE EXCEPTION 'Unexpected name for NBA CDN identity %: %', v_provider, v_name USING ERRCODE = '23514';
        END IF;
        IF lower(btrim(v_name)) = 'dillon jones' THEN
          IF EXISTS (SELECT 1 FROM players WHERE nba_id = '196295686') THEN
            IF EXISTS (SELECT 1 FROM players WHERE nba_id = '1641794') THEN
              RAISE EXCEPTION 'Reviewed NBA identity correction has two existing owners; reconcile their histories first.' USING ERRCODE = '23514';
            END IF;
            UPDATE players SET nba_id = '1641794'
              WHERE nba_id = '196295686' AND lower(btrim(display_name)) = 'dillon jones';
            IF NOT FOUND THEN
              RAISE EXCEPTION 'Unexpected stored owner for NBA CDN identity 196295686' USING ERRCODE = '23514';
            END IF;
          END IF;
          v_provider := '1641794';
        END IF;
      END IF;
      IF p_source = 'nba_draft' THEN
        IF jsonb_typeof(v_record->'nba_draft_number') IS DISTINCT FROM 'number'
          OR (v_record->>'nba_draft_number') !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'NBA draft pick must be an integer.' USING ERRCODE = '22023';
        END IF;
        v_pick := (v_record->>'nba_draft_number')::int;
        IF v_pick NOT BETWEEN 1 AND 60 THEN
          RAISE EXCEPTION 'NBA draft pick must be between 1 and 60.' USING ERRCODE = '22023';
        END IF;
      ELSE
        SELECT id INTO v_id FROM players WHERE
          CASE p_source WHEN 'espn' THEN espn_id WHEN 'sleeper' THEN sleeper_id ELSE nba_id END = v_provider;
      END IF;
      IF p_source IN ('espn', 'sleeper') AND v_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM players WHERE id=v_id
          AND private.player_import_name_key(display_name) IS DISTINCT FROM private.player_import_name_key(v_name)
          AND private.player_identity_name(display_name) IS DISTINCT FROM private.player_identity_name(v_name)
      ) THEN
        v_id := NULL;
        v_action := 'ambiguous';
      END IF;
      IF v_id IS NULL AND v_action <> 'ambiguous' THEN
        v_matches := NULL;
        IF v_team IS NOT NULL AND p_source IN ('espn', 'sleeper', 'nba_cdn') THEN
          SELECT array_agg(id) INTO v_matches FROM players
            WHERE private.player_identity_name(display_name) = private.player_identity_name(v_name)
              AND private.player_identity_team(nba_team) = v_team
              AND (CASE p_source WHEN 'espn' THEN espn_id WHEN 'sleeper' THEN sleeper_id ELSE nba_id END) IS NULL;
        END IF;
        IF coalesce(cardinality(v_matches), 0) = 0 AND p_source <> 'nba_draft' THEN
          SELECT array_agg(id) INTO v_matches FROM players WHERE lower(display_name) = lower(v_name)
            AND (v_team IS NULL OR nba_team IS NULL OR private.player_identity_team(nba_team) = v_team);
        END IF;
        IF coalesce(cardinality(v_matches), 0) = 0 THEN
          SELECT array_agg(id) INTO v_matches FROM players
            WHERE private.player_import_name_key(display_name) = private.player_import_name_key(v_name)
              AND (v_team IS NULL OR nba_team IS NULL OR private.player_identity_team(nba_team) = v_team);
        END IF;
        IF cardinality(v_matches) > 1 THEN
          IF p_source = 'nba_draft' THEN
            RAISE EXCEPTION 'Ambiguous NBA draft player: %', v_name USING ERRCODE = '23514';
          END IF;
          v_action := 'ambiguous';
        ELSE
          v_id := v_matches[1];
        END IF;
      END IF;

      -- A box can name a person differently from ESPN while the NBA index has no row for him (Yongxi Cui is
      -- "Cui Yongxi" in every Brooklyn box), so neither his NBA id nor a name joins the box to the ESPN row
      -- his fantasy team owns. The box links him to an ESPN row only when independent facts agree: the box
      -- lists him under its side; ESPN lists exactly one row on that side whose name has the same words in
      -- any order (no spelling distance, nickname or prefix), has listed it there since before this game
      -- tipped off and on no other team since, and that row carries no NBA id; and no other player on that
      -- side of this box has those words. A row an earlier box made for his NBA id, carrying no ESPN or
      -- Sleeper id, merges into that ESPN row on the same evidence, as the NBA index step merges it. Nothing
      -- links across teams or on a name alone; no import stores jersey numbers, so they cannot corroborate.
      IF p_source = 'nba_cdn' AND v_action <> 'ambiguous' AND v_game_id IS NOT NULL AND v_record ? 'nba_team'
         AND (v_id IS NULL OR EXISTS (SELECT 1 FROM players AS own WHERE own.id = v_id AND own.nba_id = v_provider
           AND own.espn_id IS NULL AND own.sleeper_id IS NULL)) THEN
        v_words := ARRAY(SELECT w FROM unnest(string_to_array(private.player_import_name_key(v_name), ' ')) AS w ORDER BY w);
        SELECT array_agg(p.id) INTO v_matches FROM players AS p JOIN player_espn_listings AS l ON l.player_id = p.id
          WHERE l.nba_team = v_record->>'nba_team'
            AND ARRAY(SELECT w FROM unnest(string_to_array(private.player_import_name_key(p.display_name), ' ')) AS w ORDER BY w) = v_words;
        v_link := NULL;
        IF cardinality(v_matches) = 1 AND (SELECT count(*) FROM jsonb_array_elements(p_records) AS r
            WHERE r->>'nba_game_id' = v_record->>'nba_game_id' AND r->>'nba_team' = v_record->>'nba_team'
              AND ARRAY(SELECT w FROM unnest(string_to_array(private.player_import_name_key(r->>'display_name'), ' ')) AS w ORDER BY w) = v_words) = 1 THEN
          SELECT p.id INTO v_link FROM players AS p JOIN player_espn_listings AS l ON l.player_id = p.id
            JOIN nba_games AS g ON g.id = v_game_id
            WHERE p.id = v_matches[1] AND p.nba_id IS NULL
              AND coalesce(l.team_since, l.listed_at) < coalesce(g.game_time, g.started_at)
            FOR UPDATE OF p;
        END IF;
        IF v_link IS NOT NULL AND v_id IS NULL THEN
          v_id := v_link;
          v_linked := 'bound';
        ELSIF v_link IS NOT NULL THEN
          v_id := public.assign_player_nba_id_atomic(v_link, v_provider);
          v_linked := 'merged';
        END IF;
      END IF;

      IF v_action <> 'ambiguous' THEN
        IF v_id IS NOT NULL THEN
          SELECT * INTO STRICT v_row FROM players WHERE id = v_id FOR UPDATE;
          IF p_source <> 'nba_draft'
            AND (CASE p_source WHEN 'espn' THEN v_row.espn_id WHEN 'sleeper' THEN v_row.sleeper_id ELSE v_row.nba_id END)
              IS NOT NULL
            AND (CASE p_source WHEN 'espn' THEN v_row.espn_id WHEN 'sleeper' THEN v_row.sleeper_id ELSE v_row.nba_id END)
              <> v_provider THEN
            RAISE EXCEPTION 'Conflicting provider identity for player %', v_id USING ERRCODE = '23514';
          END IF;
        ELSE
          INSERT INTO players(first_name, last_name, status)
          VALUES (v_first, v_last, CASE WHEN p_source = 'nba_draft' THEN 'ACT' ELSE NULL END)
          RETURNING * INTO v_row;
          v_id := v_row.id;
          v_action := 'inserted';
        END IF;

        IF p_source IN ('espn', 'sleeper') THEN
          UPDATE players SET
            espn_id = CASE WHEN p_source = 'espn' THEN v_provider ELSE espn_id END,
            sleeper_id = CASE WHEN p_source = 'sleeper' THEN v_provider ELSE sleeper_id END,
            first_name = v_first, last_name = v_last,
            nba_team = v_metadata->>'nba_team', status = v_metadata->>'status',
            injury_status = CASE WHEN v_metadata ? 'injury_status' THEN v_metadata->>'injury_status' ELSE injury_status END,
            years_exp = coalesce((v_metadata->>'years_exp')::int,years_exp),
            birthdate = coalesce((v_metadata->>'birthdate')::date,birthdate),
            position = CASE WHEN p_source='espn' THEN coalesce(v_row.position,(v_metadata->>'position')::nba_position)
              ELSE coalesce((v_metadata->>'position')::nba_position,v_row.position) END,
            eligible_positions = CASE WHEN (p_source='espn' AND cardinality(v_row.eligible_positions) > 0) OR jsonb_typeof(v_metadata->'eligible_positions') IS DISTINCT FROM 'array'
              THEN v_row.eligible_positions ELSE ARRAY(SELECT jsonb_array_elements_text(coalesce(v_metadata->'eligible_positions', '[]'))) END,
            updated_at = clock_timestamp()
          WHERE id = v_id AND
            (espn_id,sleeper_id,first_name,last_name,nba_team,status,injury_status,years_exp,birthdate,position,eligible_positions)
            IS DISTINCT FROM
            (CASE WHEN p_source='espn' THEN v_provider ELSE espn_id END,
             CASE WHEN p_source='sleeper' THEN v_provider ELSE sleeper_id END,
             v_first,v_last,v_metadata->>'nba_team',v_metadata->>'status',
             CASE WHEN v_metadata ? 'injury_status' THEN v_metadata->>'injury_status' ELSE injury_status END,
             coalesce((v_metadata->>'years_exp')::int,years_exp),coalesce((v_metadata->>'birthdate')::date,birthdate),
             CASE WHEN p_source='espn' THEN coalesce(v_row.position,(v_metadata->>'position')::nba_position)
               ELSE coalesce((v_metadata->>'position')::nba_position,v_row.position) END,
             CASE WHEN (p_source='espn' AND cardinality(v_row.eligible_positions)>0)
               OR jsonb_typeof(v_metadata->'eligible_positions') IS DISTINCT FROM 'array'
               THEN v_row.eligible_positions ELSE ARRAY(SELECT jsonb_array_elements_text(coalesce(v_metadata->'eligible_positions','[]'))) END);
          IF p_source = 'espn' THEN
            INSERT INTO player_espn_listings(player_id, nba_team, listed_at, team_since)
            VALUES (v_id, v_metadata->>'nba_team', clock_timestamp(), clock_timestamp())
            ON CONFLICT (player_id) DO UPDATE SET nba_team = EXCLUDED.nba_team, listed_at = EXCLUDED.listed_at,
              team_since = CASE WHEN player_espn_listings.nba_team IS NOT DISTINCT FROM EXCLUDED.nba_team
                THEN coalesce(player_espn_listings.team_since, player_espn_listings.listed_at) ELSE EXCLUDED.team_since END;
            PERFORM private.repair_player_game_teams(v_id);
          END IF;
        ELSIF p_source = 'nba_cdn' THEN
          UPDATE players SET nba_id = v_provider,position=coalesce(position,(v_metadata->>'position')::nba_position),
            years_exp=coalesce(years_exp,(v_metadata->>'years_exp')::int),
            eligible_positions=CASE WHEN cardinality(eligible_positions)=0 AND v_metadata->>'position' IS NOT NULL
              THEN ARRAY[v_metadata->>'position'] ELSE eligible_positions END
          WHERE id=v_id AND (nba_id IS DISTINCT FROM v_provider
            OR (position IS NULL AND v_metadata->>'position' IS NOT NULL)
            OR (years_exp IS NULL AND v_metadata->>'years_exp' IS NOT NULL));
          IF v_game_id IS NOT NULL THEN
            INSERT INTO private.player_game_memberships(player_id, game_id, nba_team)
            VALUES (v_id, v_game_id, v_record->>'nba_team') ON CONFLICT (player_id, game_id) DO UPDATE
              SET nba_team = EXCLUDED.nba_team
              WHERE EXCLUDED.nba_team IS NOT NULL AND player_game_memberships.nba_team IS DISTINCT FROM EXCLUDED.nba_team;
          END IF;
        ELSE
          IF v_id = ANY(v_ids) THEN
            RAISE EXCEPTION 'Multiple draft picks resolve to the same player.' USING ERRCODE = '23514';
          END IF;
          -- A board can only describe a class that has not played yet. An experienced match means a past
          -- board or a wrong identity; refuse the whole board rather than rewriting history or class data.
          IF EXISTS (SELECT 1 FROM players WHERE id = v_id AND coalesce(years_exp, 0) > 0) THEN
            RAISE EXCEPTION 'Draft pick % matches an experienced player; refusing to replace the draft board.', v_pick USING ERRCODE = '23514';
          END IF;
          UPDATE players SET years_exp = 0, nba_draft_number = v_pick, updated_at = clock_timestamp()
          WHERE id = v_id AND (years_exp,nba_draft_number) IS DISTINCT FROM (0,v_pick);
          v_ids := array_append(v_ids, v_id);
        END IF;
      END IF;
    END IF;
    v_results := v_results || jsonb_build_array(jsonb_build_object('index', v_index - 1, 'player_id', v_id, 'action', v_action)
      || CASE WHEN v_linked IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('linked', v_linked) END);
  END LOOP;
  IF p_source = 'nba_draft' THEN
    UPDATE players SET nba_draft_number = NULL WHERE nba_draft_number IS NOT NULL AND NOT id = ANY(v_ids);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('results', v_results, 'stale_draft_numbers_cleared', v_cleared);
END;
$$;

COMMIT;
