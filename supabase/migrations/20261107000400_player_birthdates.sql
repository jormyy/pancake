BEGIN;
ALTER TABLE public.players ADD COLUMN birthdate date CHECK(birthdate >= DATE '1900-01-01' AND birthdate <= CURRENT_DATE);
DROP FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer);
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
      IF v_id IS NULL THEN
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
          WHERE id = v_id;
          IF p_source = 'espn' THEN
            INSERT INTO player_espn_listings(player_id, nba_team, listed_at, team_since)
            VALUES (v_id, v_metadata->>'nba_team', clock_timestamp(), clock_timestamp())
            ON CONFLICT (player_id) DO UPDATE SET nba_team = EXCLUDED.nba_team, listed_at = EXCLUDED.listed_at,
              team_since = CASE WHEN player_espn_listings.nba_team IS NOT DISTINCT FROM EXCLUDED.nba_team
                THEN coalesce(player_espn_listings.team_since, player_espn_listings.listed_at) ELSE EXCLUDED.team_since END;
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

CREATE OR REPLACE FUNCTION public.view_player_search(
  p_query text DEFAULT '',
  p_position text DEFAULT 'ALL',
  p_teams text[] DEFAULT '{}',
  p_league_id uuid DEFAULT NULL,
  p_playing_teams text[] DEFAULT NULL,
  p_excluded_teams text[] DEFAULT '{}',
  p_include_player_ids uuid[] DEFAULT NULL,
  p_exclude_player_ids uuid[] DEFAULT '{}',
  p_rookies_only boolean DEFAULT false,
  p_health text DEFAULT 'all',
  p_sort_by text DEFAULT 'fpts',
  p_sort_dir text DEFAULT 'desc',
  p_season_year int DEFAULT NULL,
  p_limit int DEFAULT 20,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  status text,
  injury_status text,
  headshot_url text,
  nba_id text,
  years_exp int,
  avg_fantasy_points numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_turnovers numeric,
  avg_three_pointers_made numeric,
  avg_minutes_played numeric,
  games_played int,
  projection_fantasy_points numeric,
  projection_source text,
  projection_source_label text,
  projection_view text,
  projection_fetched_at timestamptz,
  projection_date date,
  projection_opponent text,
  projection_minutes numeric,
  projection_points numeric,
  projection_rebounds numeric,
  projection_assists numeric,
  projection_steals numeric,
  projection_blocks numeric,
  projection_three_pointers_made numeric,
  projection_turnovers numeric,
  projection_status text,
  stats_season_year int,
  career_regular_season_games int,
  birthdate date,
  age int
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  v_stats_season int;
  v_current_season int := public.current_season_year_et();
BEGIN
v_stats_season := COALESCE(p_season_year, CASE WHEN EXISTS (
  SELECT 1
  FROM public.nba_games g
  WHERE g.season_year = v_current_season
    AND public.is_regular_season_game_id(g.nba_game_id)
    AND (g.status = 'Final' OR EXISTS (
      SELECT 1 FROM public.player_game_stats s
      WHERE s.game_id = g.id
        AND NOT s.did_not_play
        AND (s.minutes_played > 0 OR s.points > 0 OR s.rebounds > 0
          OR s.assists > 0 OR s.steals > 0 OR s.blocks > 0
          OR s.turnovers > 0 OR s.field_goals_attempted > 0
          OR s.free_throws_attempted > 0)
    ))
) THEN v_current_season ELSE v_current_season - 1 END);
RETURN QUERY
WITH args AS (
  SELECT
    NULLIF(trim(COALESCE(p_query, '')), '') AS query_text,
    CASE COALESCE(p_position, 'ALL')
      WHEN 'ALL' THEN ARRAY[]::text[]
      WHEN 'G' THEN ARRAY['PG', 'SG']::text[]
      WHEN 'F' THEN ARRAY['SF', 'PF']::text[]
      ELSE ARRAY[p_position]::text[]
    END AS pos_filter,
    CASE
      WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN
          ARRAY(
            SELECT explicit_team
            FROM unnest(COALESCE(p_teams, '{}')) AS explicit_team
            WHERE explicit_team = ANY(COALESCE(p_playing_teams, '{}'))
            ORDER BY explicit_team
          )
      WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')
      ELSE COALESCE(p_teams, '{}')
    END AS effective_teams,
    (p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active,
    COALESCE(p_excluded_teams, '{}') AS excluded_teams,
    COALESCE(p_exclude_player_ids, '{}') AS exclude_player_ids,
    LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
current_averages AS MATERIALIZED (
  SELECT cached.player_id, cached.season_year, cached.avg_fantasy_points,
    (cached.averages->>'avg_points')::numeric AS avg_points,
    (cached.averages->>'avg_rebounds')::numeric AS avg_rebounds,
    (cached.averages->>'avg_assists')::numeric AS avg_assists,
    (cached.averages->>'avg_steals')::numeric AS avg_steals,
    (cached.averages->>'avg_blocks')::numeric AS avg_blocks,
    (cached.averages->>'avg_turnovers')::numeric AS avg_turnovers,
    (cached.averages->>'avg_three_pointers_made')::numeric AS avg_three_pointers_made,
    (cached.averages->>'avg_minutes_played')::numeric AS avg_minutes_played,
    (cached.averages->>'games_played')::integer AS games_played
  FROM public.player_season_averages cached
  WHERE cached.league_id = p_league_id AND cached.season_year = v_stats_season
    AND v_stats_season = v_current_season AND cached.averages IS NOT NULL
    AND (p_include_player_ids IS NULL OR cached.player_id = ANY(p_include_player_ids))
),
season_averages AS (
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM current_averages
  UNION ALL
  SELECT
    player_id,
    season_year,
    avg_points,
    avg_rebounds,
    avg_assists,
    avg_steals,
    avg_blocks,
    avg_turnovers,
    avg_three_pointers_made,
    avg_minutes_played,
    games_played
  FROM public.mv_player_season_averages
  WHERE season_year = v_stats_season AND v_stats_season <> v_current_season
),
league_scores AS MATERIALIZED (
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND (p_include_player_ids IS NULL OR fp.player_id = ANY(p_include_player_ids))
),
score_source AS (
  SELECT player_id, avg_fantasy_points FROM current_averages
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM public.v_player_avg_fantasy_points AS fp
  WHERE fp.league_id = p_league_id
    AND fp.season_year = v_stats_season
    AND v_stats_season <> v_current_season
    AND NOT COALESCE(p_health IN ('healthy', 'gtd', 'out', 'ir'), false)
  UNION ALL
  SELECT fp.player_id, fp.avg_fantasy_points
  FROM league_scores AS fp
  WHERE p_health IN ('healthy', 'gtd', 'out', 'ir')
),
filtered_base AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.status,
    p.injury_status,
    p.headshot_url,
    p.nba_id,
    p.years_exp,
    p.career_regular_season_games,
    p.birthdate,
    fp.avg_fantasy_points,
    avg.avg_points,
    avg.avg_rebounds,
    avg.avg_assists,
    avg.avg_steals,
    avg.avg_blocks,
    avg.avg_turnovers,
    avg.avg_three_pointers_made,
    avg.avg_minutes_played,
    avg.games_played::int AS games_played
  FROM args
  JOIN public.players AS p ON true
  LEFT JOIN season_averages AS avg
    ON avg.player_id = p.id
   AND avg.season_year = v_stats_season
  LEFT JOIN score_source AS fp
    ON fp.player_id = p.id
  WHERE
    (args.query_text IS NULL OR p.display_name ILIKE ('%' || args.query_text || '%'))
    AND (cardinality(args.pos_filter) = 0 OR EXISTS (
      SELECT 1
      FROM unnest(p.eligible_positions) AS player_position
      WHERE player_position::text = ANY(args.pos_filter)
    ))
    AND (NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))
    AND (cardinality(args.excluded_teams) = 0 OR p.nba_team IS NULL OR p.nba_team <> ALL(args.excluded_teams))
    AND (p_include_player_ids IS NULL OR p.id = ANY(p_include_player_ids))
    AND (cardinality(args.exclude_player_ids) = 0 OR p.id <> ALL(args.exclude_player_ids))
    AND (NOT p_rookies_only OR p.years_exp = 0)
    AND CASE COALESCE(p_health, 'all')
      WHEN 'healthy' THEN p.injury_status IS NULL
      WHEN 'gtd' THEN p.injury_status = ANY(ARRAY['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
      WHEN 'out' THEN p.injury_status = ANY(ARRAY['Out', 'OUT', 'O'])
      WHEN 'ir' THEN p.injury_status = ANY(ARRAY['IR', 'IR-LTI'])
      ELSE true
    END
),
paged_base AS (
  SELECT *
  FROM (
    SELECT
      filtered_base.*,
      row_number() OVER (
        ORDER BY
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN filtered_base.avg_fantasy_points END ASC NULLS LAST,
          CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN filtered_base.avg_fantasy_points END DESC NULLS LAST,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END ASC,
          CASE WHEN p_sort_by = 'min' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_minutes_played, 0) END DESC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_points, 0) END ASC,
          CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_points, 0) END DESC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END ASC,
          CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_rebounds, 0) END DESC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END ASC,
          CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_assists, 0) END DESC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END ASC,
          CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_steals, 0) END DESC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END ASC,
          CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_blocks, 0) END DESC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END ASC,
          CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_three_pointers_made, 0) END DESC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END ASC,
          CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.avg_turnovers, 0) END DESC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered_base.games_played, 0) END ASC,
          CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered_base.games_played, 0) END DESC,
          filtered_base.display_name ASC,
          filtered_base.id ASC
      ) AS page_rank
    FROM filtered_base
  ) ranked_base
  ORDER BY page_rank
  LIMIT (SELECT page_limit FROM args)
  OFFSET (SELECT page_offset FROM args)
),
projection AS (
  SELECT *
  FROM public.get_league_projection_rows(
    p_league_id,
    v_stats_season,
    (timezone('America/New_York', now()))::date,
    'today',
    COALESCE((SELECT array_agg(paged_base.id ORDER BY paged_base.id) FROM paged_base), ARRAY[]::uuid[]),
    (SELECT page_limit FROM args),
    0
  )
  WHERE p_league_id IS NOT NULL
)
SELECT
  pb.id,
  pb.display_name,
  pb.nba_team,
  pb."position",
  pb.eligible_positions,
  pb.status,
  pb.injury_status,
  pb.headshot_url,
  pb.nba_id,
  pb.years_exp,
  pb.avg_fantasy_points,
  pb.avg_points,
  pb.avg_rebounds,
  pb.avg_assists,
  pb.avg_steals,
  pb.avg_blocks,
  pb.avg_turnovers,
  pb.avg_three_pointers_made,
  pb.avg_minutes_played,
  pb.games_played,
  proj.projection_fantasy_points,
  proj.projection_source,
  proj.projection_source_label,
  proj.projection_view,
  proj.projection_fetched_at,
  proj.projection_date,
  proj.next_game_opponent AS projection_opponent,
  proj.projection_minutes,
  proj.projection_points,
  proj.projection_rebounds,
  proj.projection_assists,
  proj.projection_steals,
  proj.projection_blocks,
  proj.projection_three_pointers_made,
  proj.projection_turnovers,
  proj.projection_status,
  v_stats_season,
  pb.career_regular_season_games,
  pb.birthdate,
  extract(year FROM age((now() AT TIME ZONE 'America/Los_Angeles')::date,pb.birthdate))::int
FROM paged_base pb
LEFT JOIN projection AS proj
  ON proj.player_id = pb.id
ORDER BY pb.page_rank;
END;
$$;

CREATE OR REPLACE FUNCTION public.view_player(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE context jsonb; player public.players%ROWTYPE; average jsonb; fantasy numeric; lines jsonb; transactions jsonb; projection jsonb;
  games jsonb; fantasy_map jsonb;
BEGIN
  context := public.view_context(p_league_id, p_member_id,
    p_params || jsonb_build_object('seasonYear', COALESCE((p_params->>'seasonYear')::integer, public.current_season_year_et())));
  SELECT * INTO player FROM public.players WHERE id = (p_params->>'playerId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE = 'P0002'; END IF;
  SELECT averages, avg_fantasy_points INTO average, fantasy FROM public.player_season_averages
    WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  IF NOT FOUND THEN
    SELECT to_jsonb(row) INTO average FROM public.mv_player_season_averages row WHERE player_id = player.id AND season_year = (context->>'seasonYear')::integer;
    SELECT avg_fantasy_points INTO fantasy FROM public.v_player_avg_fantasy_points WHERE league_id = p_league_id AND player_id = player.id AND season_year = (context->>'seasonYear')::integer;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(stat) - 'game_id' || jsonb_build_object('nba_games', to_jsonb(game)) ORDER BY stat.game_date DESC, stat.id DESC), '[]')
    INTO lines FROM (SELECT stat.* FROM public.player_game_stats stat JOIN public.nba_games game ON game.id = stat.game_id
      WHERE stat.player_id = player.id AND stat.season_year = (context->>'seasonYear')::integer AND game.nba_game_id LIKE '002%'
      ORDER BY stat.game_date DESC, stat.id DESC LIMIT 100) stat JOIN public.nba_games game ON game.id = stat.game_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', t.id, 'transactionType', t.transaction_type, 'label', CASE t.transaction_type
    WHEN 'fa_add' THEN 'Added' WHEN 'fa_drop' THEN 'Dropped' WHEN 'waiver_add' THEN 'Claimed' WHEN 'waiver_drop' THEN 'Dropped'
    WHEN 'trade_in' THEN 'Acquired via Trade' WHEN 'trade_out' THEN 'Traded Away' WHEN 'ir_designate' THEN 'Placed on IR'
    WHEN 'ir_return' THEN 'Activated from IR' WHEN 'taxi_designate' THEN 'Placed on Taxi Squad' WHEN 'taxi_return' THEN 'Activated from Taxi Squad'
    WHEN 'draft_won' THEN 'Drafted' WHEN 'carry_over' THEN 'Carried Over' ELSE t.transaction_type END,
    'teamName', COALESCE(member.team_name, 'Unknown'), 'occurredAt', t.occurred_at) ORDER BY t.occurred_at DESC, t.id DESC), '[]')
    INTO transactions FROM (SELECT * FROM public.roster_transactions WHERE league_id = p_league_id AND player_id = player.id
      ORDER BY occurred_at DESC, id DESC LIMIT 20) t LEFT JOIN public.league_members member ON member.id = t.member_id;
  SELECT to_jsonb(row) INTO projection FROM public.get_league_projection_rows(p_league_id, public.current_season_year_et(),
    (context->>'today')::date, 'today', ARRAY[player.id], 1, 0) row;
  WITH ordered AS (
    SELECT line, line->'nba_games' AS game, COALESCE((line->>'is_home')::boolean,
      CASE WHEN line->'nba_games'->>'home_team' = player.nba_team THEN true WHEN line->'nba_games'->>'away_team' = player.nba_team THEN false END) AS home
    FROM jsonb_array_elements(lines) line
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('gameId', line->'id', 'nbaGameId', game->'id', 'gameDate', game->'game_date',
    'opponent', CASE WHEN home THEN 'vs ' || (game->>'away_team') WHEN home = false THEN '@ ' || (game->>'home_team')
      ELSE (game->>'away_team') || ' @ ' || (game->>'home_team') END, 'isHome', COALESCE(home, false),
    'live', replace(lower(game->>'status'), '_', '') = 'inprogress', 'didNotPlay', line->'did_not_play',
    'minutes', line->'minutes_played', 'points', COALESCE(NULLIF(line->'points', 'null'), '0'), 'rebounds', COALESCE(NULLIF(line->'rebounds', 'null'), '0'),
    'assists', COALESCE(NULLIF(line->'assists', 'null'), '0'), 'steals', COALESCE(NULLIF(line->'steals', 'null'), '0'), 'blocks', COALESCE(NULLIF(line->'blocks', 'null'), '0'),
    'turnovers', COALESCE(NULLIF(line->'turnovers', 'null'), '0'), 'personalFouls', COALESCE(NULLIF(line->'personal_fouls', 'null'), '0'),
    'fgMade', COALESCE(NULLIF(line->'field_goals_made', 'null'), '0'), 'fgAttempted', COALESCE(NULLIF(line->'field_goals_attempted', 'null'), '0'),
    'threeMade', COALESCE(NULLIF(line->'three_pointers_made', 'null'), '0'), 'threeAttempted', COALESCE(NULLIF(line->'three_pointers_attempted', 'null'), '0'),
    'ftMade', COALESCE(NULLIF(line->'free_throws_made', 'null'), '0'), 'ftAttempted', COALESCE(NULLIF(line->'free_throws_attempted', 'null'), '0'),
    'plusMinus', COALESCE(NULLIF(line->'plus_minus', 'null'), '0'), 'doubleDouble', COALESCE(NULLIF(line->'double_double', 'null'), 'false'),
    'tripleDouble', COALESCE(NULLIF(line->'triple_double', 'null'), 'false')) ORDER BY game->>'game_date' DESC, line->>'id' DESC), '[]'),
    COALESCE(jsonb_object_agg(line->>'id', public.compute_fantasy_points((line->>'id')::uuid, p_league_id)), '{}')
    INTO games, fantasy_map FROM ordered;
  IF fantasy IS NULL THEN
    SELECT COALESCE(avg((fantasy_map->>(line->>'id'))::numeric) FILTER (WHERE NOT (line->>'did_not_play')::boolean), 0) INTO fantasy
      FROM jsonb_array_elements(lines) line;
  END IF;
  RETURN jsonb_build_object('context', context, 'player', to_jsonb(player) || jsonb_build_object('age', extract(year FROM age((now() AT TIME ZONE 'America/Los_Angeles')::date,player.birthdate))::int, 'display_name', COALESCE(player.display_name, concat_ws(' ', player.first_name, player.last_name))),
    'availableSeasons', COALESCE((SELECT jsonb_agg(season_year ORDER BY season_year DESC) FROM (
      SELECT season_year FROM public.mv_player_season_averages WHERE player_id = player.id
      UNION SELECT public.current_season_year_et()) years), '[]'),
    'averages', CASE WHEN COALESCE((average->>'games_played')::integer, 0) > 0 THEN jsonb_build_object(
      'gamesPlayed', average->'games_played', 'avgPoints', COALESCE(NULLIF(average->'avg_points', 'null'), '0'), 'avgRebounds', COALESCE(NULLIF(average->'avg_rebounds', 'null'), '0'),
      'avgAssists', COALESCE(NULLIF(average->'avg_assists', 'null'), '0'), 'avgSteals', COALESCE(NULLIF(average->'avg_steals', 'null'), '0'), 'avgBlocks', COALESCE(NULLIF(average->'avg_blocks', 'null'), '0'),
      'avgTurnovers', COALESCE(NULLIF(average->'avg_turnovers', 'null'), '0'), 'avgThreePointersMade', COALESCE(NULLIF(average->'avg_three_pointers_made', 'null'), '0'),
      'avgFieldGoalsMade', COALESCE(NULLIF(average->'avg_field_goals_made', 'null'), '0'), 'avgFieldGoalsAttempted', COALESCE(NULLIF(average->'avg_field_goals_attempted', 'null'), '0'),
      'avgFreeThrowsMade', COALESCE(NULLIF(average->'avg_free_throws_made', 'null'), '0'), 'avgFreeThrowsAttempted', COALESCE(NULLIF(average->'avg_free_throws_attempted', 'null'), '0'),
      'avgMinutesPlayed', COALESCE(NULLIF(average->'avg_minutes_played', 'null'), '0'), 'doubleDoubles', COALESCE(NULLIF(average->'double_doubles', 'null'), '0'), 'tripleDoubles', COALESCE(NULLIF(average->'triple_doubles', 'null'), '0')) END,
    'avgFantasyPoints', fantasy, 'lines', lines, 'transactions', transactions, 'projection', projection, 'nextProjection', projection,
    'gameLog', COALESCE((SELECT jsonb_agg(game ORDER BY ordinal) FROM jsonb_array_elements(games) WITH ORDINALITY entries(game, ordinal)
      WHERE ordinal <= LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100)), '[]'),
    'hasMoreGames', jsonb_array_length(games) > LEAST(GREATEST(COALESCE((p_params->>'gameLimit')::integer, 15), 1), 100),
    'includesLive', EXISTS (SELECT 1 FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean),
    'liveGame', (SELECT game FROM jsonb_array_elements(games) game WHERE (game->>'live')::boolean AND NOT (game->>'didNotPlay')::boolean LIMIT 1),
    'fantasyPointsMap', fantasy_map, 'selectedSeason', (context->>'seasonYear')::integer,
    'scoringSettings', context->'league'->'scoring_settings', 'roster', public.view_roster(p_league_id, p_member_id, p_params));
END;
$$;

REVOKE ALL ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.view_player_search(text,text,text[],uuid,text[],text[],uuid[],uuid[],boolean,text,text,text,integer,integer,integer) TO authenticated;
COMMIT;
