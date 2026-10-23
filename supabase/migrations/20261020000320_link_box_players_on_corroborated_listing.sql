-- No player is lost where positive evidence exists. Yongxi Cui (ESPN 5159486, "Yongxi Cui", Brooklyn) is "Cui
-- Yongxi" (personId 1642385) in all 25 of his pinned 2024-25 Brooklyn boxes, and the pinned NBA player index has
-- no row for him. Neither his NBA id nor either name key joined a box to his ESPN row, so every box made a
-- CDN-only row and the fantasy team that owned and started him scored 0 for him, including in a week that
-- finalized with the split (players-t19-corroborated-identity, red on 65b26b7a). An NBA box player that no NBA
-- id or name joins now links to an existing ESPN row only on corroborated evidence: the box lists him under its
-- side; ESPN lists exactly one row on that side whose name has the same words in any order; ESPN has listed it
-- there since before the game tipped off and on no other team since; the row carries no NBA id; and no other
-- player on that side of the box has those words. A CDN-only row an earlier box made for his NBA id merges into
-- that ESPN row on the same evidence. ESPN's listing now keeps when it first listed him on his current team.

ALTER TABLE private.player_espn_listings ADD COLUMN team_since timestamptz;
COMMENT ON COLUMN private.player_espn_listings.team_since IS
  'Since when ESPN has listed him on nba_team without listing him on another team in between; null on listings recorded before this column, where listed_at stands in.';

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
  -- and tipped off after ESPN last listed him on his team (player_espn_listings); a later listing in a
  -- game of his own team wins, and so does an earlier ESPN listing time. A box lists him under his side,
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
          FROM player_espn_listings AS l
          JOIN (SELECT s.game_id FROM player_game_stats AS s WHERE s.player_id = c.id
                UNION SELECT m.game_id FROM private.player_game_memberships AS m WHERE m.player_id = c.id) AS listed ON true
          JOIN nba_games AS g ON g.id = listed.game_id
          LEFT JOIN private.player_game_memberships AS side ON side.player_id = c.id AND side.game_id = g.id
          WHERE l.player_id = c.id AND l.nba_team = c.nba_team
            AND g.nba_game_id ~ '^00[2456]' AND coalesce(g.game_time, g.started_at) > l.listed_at
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
      OR (p_source = 'nba_draft' AND p.nba_draft_number IS NOT NULL)
    ORDER BY p.id FOR UPDATE;
  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    v_index := v_index + 1;
    v_metadata := coalesce(v_record->'metadata', '{}'::jsonb);
    v_allowed := CASE WHEN p_source IN ('espn', 'sleeper')
      THEN ARRAY['nba_team', 'position', 'eligible_positions', 'status', 'injury_status', 'years_exp']
      ELSE ARRAY[]::text[] END;
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
      IF v_id IS NULL THEN
        v_matches := NULL;
        IF p_source <> 'nba_draft' THEN
          SELECT array_agg(id) INTO v_matches FROM players WHERE lower(display_name) = lower(v_name);
        END IF;
        IF coalesce(cardinality(v_matches), 0) <> 1 THEN
          SELECT array_agg(id) INTO v_matches FROM players
            WHERE private.player_import_name_key(display_name) = private.player_import_name_key(v_name);
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
            injury_status = v_metadata->>'injury_status', years_exp = (v_metadata->>'years_exp')::int,
            position = CASE WHEN p_source = 'espn' AND (v_row.position IS NOT NULL OR cardinality(v_row.eligible_positions) > 0)
              THEN v_row.position ELSE (v_metadata->>'position')::nba_position END,
            eligible_positions = CASE WHEN p_source = 'espn' AND (v_row.position IS NOT NULL OR cardinality(v_row.eligible_positions) > 0)
              THEN v_row.eligible_positions ELSE ARRAY(SELECT jsonb_array_elements_text(coalesce(v_metadata->'eligible_positions', '[]'))) END,
            updated_at = clock_timestamp()
          WHERE id = v_id;
          IF p_source = 'espn' THEN
            INSERT INTO player_espn_listings(player_id, nba_team, listed_at, team_since)
            VALUES (v_id, v_metadata->>'nba_team', clock_timestamp(), clock_timestamp())
            ON CONFLICT (player_id) DO UPDATE SET nba_team = EXCLUDED.nba_team, listed_at = EXCLUDED.listed_at,
              team_since = CASE WHEN player_espn_listings.nba_team IS NOT DISTINCT FROM EXCLUDED.nba_team
                THEN coalesce(player_espn_listings.team_since, player_espn_listings.listed_at) ELSE EXCLUDED.team_since END;
          END IF;
        ELSIF p_source = 'nba_cdn' THEN
          UPDATE players SET nba_id = v_provider WHERE id = v_id AND nba_id IS DISTINCT FROM v_provider;
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
          UPDATE players SET years_exp = 0, nba_draft_number = v_pick, updated_at = clock_timestamp() WHERE id = v_id;
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
