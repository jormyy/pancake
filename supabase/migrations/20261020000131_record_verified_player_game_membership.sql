CREATE TABLE private.player_game_memberships (
  player_id uuid NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES public.nba_games(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (player_id, game_id)
);

ALTER TABLE private.player_game_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.player_game_memberships FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON private.player_game_memberships TO authenticated, service_role;
CREATE POLICY player_game_memberships_read ON private.player_game_memberships
  FOR SELECT TO authenticated, service_role USING (true);


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
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('espn', 'sleeper', 'nba_cdn', 'nba_index', 'nba_draft')
     OR p_records IS NULL OR jsonb_typeof(p_records) <> 'array'
     OR jsonb_array_length(p_records) > 500 THEN
    RAISE EXCEPTION 'Invalid player import source or records.' USING ERRCODE = '22023';
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
        WHEN p_source = 'nba_cdn' THEN ARRAY['provider_id', 'display_name', 'metadata', 'nba_game_id']
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
    v_id := NULL;
    v_action := 'updated';

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
        ELSIF p_source = 'nba_cdn' THEN
          UPDATE players SET nba_id = v_provider WHERE id = v_id AND nba_id IS DISTINCT FROM v_provider;
          IF v_game_id IS NOT NULL THEN
            INSERT INTO private.player_game_memberships(player_id, game_id)
            VALUES (v_id, v_game_id) ON CONFLICT (player_id, game_id) DO NOTHING;
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
    v_results := v_results || jsonb_build_array(jsonb_build_object('index', v_index - 1, 'player_id', v_id, 'action', v_action));
  END LOOP;
  IF p_source = 'nba_draft' THEN
    UPDATE players SET nba_draft_number = NULL WHERE nba_draft_number IS NOT NULL AND NOT id = ANY(v_ids);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('results', v_results, 'stale_draft_numbers_cleared', v_cleared);
END;
$$;

CREATE OR REPLACE FUNCTION merge_players(winner_id uuid, loser_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_winner players%ROWTYPE;
  v_loser players%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(1347174745, 1);
  IF winner_id = loser_id THEN RETURN; END IF;
  PERFORM id FROM players WHERE id IN (winner_id, loser_id) ORDER BY id FOR UPDATE;
  SELECT * INTO v_winner FROM players WHERE id = winner_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v_loser FROM players WHERE id = loser_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF (v_winner.nba_id IS NOT NULL AND v_loser.nba_id IS NOT NULL AND v_winner.nba_id <> v_loser.nba_id)
    OR (v_winner.espn_id IS NOT NULL AND v_loser.espn_id IS NOT NULL AND v_winner.espn_id <> v_loser.espn_id)
    OR (v_winner.sleeper_id IS NOT NULL AND v_loser.sleeper_id IS NOT NULL AND v_winner.sleeper_id <> v_loser.sleeper_id)
    OR (v_winner.sportsdata_id IS NOT NULL AND v_loser.sportsdata_id IS NOT NULL AND v_winner.sportsdata_id <> v_loser.sportsdata_id) THEN
    RAISE EXCEPTION 'Cannot merge conflicting provider identities.' USING ERRCODE = '23514';
  END IF;

  -- Release unique provider links before moving them to the surviving identity.
  UPDATE players SET
    sleeper_id = CASE WHEN v_winner.sleeper_id IS NULL THEN NULL ELSE sleeper_id END,
    nba_id = CASE WHEN v_winner.nba_id IS NULL THEN NULL ELSE nba_id END,
    espn_id = CASE WHEN v_winner.espn_id IS NULL THEN NULL ELSE espn_id END,
    sportsdata_id = CASE WHEN v_winner.sportsdata_id IS NULL THEN NULL ELSE sportsdata_id END
  WHERE id = loser_id;

  UPDATE players SET
    sleeper_id = COALESCE(v_winner.sleeper_id, v_loser.sleeper_id),
    nba_id = COALESCE(v_winner.nba_id, v_loser.nba_id),
    espn_id = COALESCE(v_winner.espn_id, v_loser.espn_id),
    sportsdata_id = COALESCE(v_winner.sportsdata_id, v_loser.sportsdata_id),
    nba_team = COALESCE(v_winner.nba_team, v_loser.nba_team),
    position = COALESCE(v_winner.position, v_loser.position),
    eligible_positions = CASE WHEN cardinality(v_winner.eligible_positions) = 0
      THEN v_loser.eligible_positions ELSE v_winner.eligible_positions END,
    headshot_url = COALESCE(v_winner.headshot_url, v_loser.headshot_url),
    jersey_number = COALESCE(v_winner.jersey_number, v_loser.jersey_number),
    years_exp = COALESCE(v_winner.years_exp, v_loser.years_exp),
    nba_draft_number = COALESCE(v_winner.nba_draft_number, v_loser.nba_draft_number),
    -- A backfill stub has no team or position. Its empty injury status is unknown.
    injury_status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_winner.injury_status, v_loser.injury_status) ELSE v_winner.injury_status END,
    status = CASE WHEN v_winner.nba_team IS NULL AND v_winner.position IS NULL
      THEN COALESCE(v_loser.status, v_winner.status) ELSE v_winner.status END,
    dynasty_rank = COALESCE(v_winner.dynasty_rank, v_loser.dynasty_rank),
    dynasty_rank_source = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_source ELSE v_winner.dynasty_rank_source END,
    dynasty_rank_fetched_at = CASE WHEN v_winner.dynasty_rank IS NULL
      THEN v_loser.dynasty_rank_fetched_at ELSE v_winner.dynasty_rank_fetched_at END
  WHERE id = winner_id;

  -- The same team's existing taxi acquisition survives a duplicate active/IR
  -- identity. Normal delete guards and cleanup apply to the redundant row.
  DELETE FROM roster_players AS canonical
  USING roster_players AS taxi
  WHERE canonical.player_id = winner_id
    AND taxi.player_id = loser_id
    AND canonical.league_id = taxi.league_id
    AND canonical.league_season_id = taxi.league_season_id
    AND canonical.member_id = taxi.member_id
    AND NOT canonical.is_on_taxi
    AND taxi.is_on_taxi;

  -- Otherwise, a member who already holds the winner active keeps that row,
  -- so their listings, lineups, pending drops and offers move to the winner
  -- before their loser row goes; the roster lifecycle trigger then finds
  -- nothing of theirs under the old identity. Every other member's state is
  -- cleared by that trigger when their loser row is deleted below, or moves
  -- with their roster row when it is re-pointed.
  DELETE FROM trade_block_items AS stale
    WHERE stale.player_id = loser_id
      AND EXISTS (
        SELECT 1 FROM trade_block_items AS kept
         WHERE kept.league_id = stale.league_id
           AND kept.member_id = stale.member_id
           AND kept.player_id = winner_id
      );
  UPDATE trade_block_items AS listing
     SET player_id = winner_id
   WHERE listing.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
         JOIN league_seasons AS season ON season.id = own.league_season_id AND season.is_current = true
        WHERE own.player_id = winner_id AND own.member_id = listing.member_id AND own.league_id = listing.league_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  DELETE FROM weekly_lineups
    WHERE player_id = loser_id
      AND (league_id, league_season_id, member_id, game_date) IN (
        SELECT league_id, league_season_id, member_id, game_date
          FROM weekly_lineups WHERE player_id = winner_id
      );
  UPDATE weekly_lineups AS lineup
     SET player_id = winner_id
   WHERE lineup.player_id = loser_id
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = lineup.member_id AND own.league_season_id = lineup.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE waiver_claims AS claim
     SET drop_player_id = winner_id
   WHERE claim.drop_player_id = loser_id
     AND claim.status = 'pending'::waiver_claim_status
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = claim.member_id AND own.league_season_id = claim.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  UPDATE trade_items AS item
     SET player_id = winner_id
    FROM trades AS trade
   WHERE trade.id = item.trade_id
     AND item.player_id = loser_id
     AND trade.status IN ('pending'::trade_status, 'accepted'::trade_status)
     AND EXISTS (
       SELECT 1 FROM roster_players AS own
        WHERE own.player_id = winner_id AND own.member_id = item.from_member_id AND own.league_season_id = trade.league_season_id
          AND own.is_on_ir = false AND own.is_on_taxi = false
     );

  PERFORM private.authorize_taxi_acquisition(league_id,league_season_id,member_id,winner_id,'merge',loser_id)
    FROM roster_players WHERE player_id=loser_id AND is_on_taxi;

  -- roster_players: drop the loser's rows that already have a winner row in the
  -- same (league, season), then re-point the rest.
  DELETE FROM roster_players
    WHERE player_id = loser_id
      AND (league_id, league_season_id) IN (
        SELECT league_id, league_season_id FROM roster_players WHERE player_id = winner_id
      );
  UPDATE roster_players SET player_id = winner_id WHERE player_id = loser_id;

  -- Everything still under the loser identity belongs to a re-pointed roster
  -- row or to history; it moves with the identity.
  UPDATE trade_block_items SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE weekly_lineups    SET player_id = winner_id WHERE player_id = loser_id;

  DELETE FROM player_projections
    WHERE player_id = loser_id
      AND (season_year, week_number) IN (
        SELECT season_year, week_number FROM player_projections WHERE player_id = winner_id
      );
  UPDATE player_projections SET player_id = winner_id WHERE player_id = loser_id;

  -- Keep both original auctions and their bid/transaction links when identities collide.
  -- One unmarked nomination per draft/player still guards ordinary entry.
  UPDATE nominations AS loser
     SET merged_from_player_id = COALESCE(loser.merged_from_player_id,loser_id)
   WHERE loser.player_id = loser_id
     AND EXISTS (SELECT 1 FROM nominations AS winner
       WHERE winner.draft_id=loser.draft_id AND winner.player_id=winner_id);
  UPDATE nominations SET player_id = winner_id WHERE player_id = loser_id;

  UPDATE waiver_claims       SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE waiver_claims       SET drop_player_id = winner_id WHERE drop_player_id = loser_id;
  UPDATE waiver_wire_log     SET player_id = winner_id WHERE player_id = loser_id;

  -- One identity cannot be rostered and clearing waivers in the same season.
  UPDATE waiver_wire_log AS log
     SET cleared_at = now()
   WHERE log.player_id = winner_id
     AND log.cleared_at IS NULL
     AND EXISTS (
       SELECT 1
         FROM roster_players AS roster
        WHERE roster.league_id = log.league_id
          AND roster.league_season_id = log.league_season_id
          AND roster.player_id = winner_id
     );
  UPDATE trade_items         SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE roster_transactions SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE snake_draft_picks   SET player_id = winner_id WHERE player_id = loser_id;

  INSERT INTO private.player_game_memberships(player_id, game_id, first_seen_at)
    SELECT winner_id, game_id, first_seen_at FROM private.player_game_memberships WHERE player_id = loser_id
    ON CONFLICT (player_id, game_id) DO UPDATE
      SET first_seen_at = LEAST(player_game_memberships.first_seen_at, EXCLUDED.first_seen_at);

  DELETE FROM player_game_stats
    WHERE player_id = loser_id
      AND game_id IN (SELECT game_id FROM player_game_stats WHERE player_id = winner_id);
  UPDATE player_game_stats SET player_id = winner_id WHERE player_id = loser_id;

  -- Retain unattributed legacy evidence without using it for eligibility.
  INSERT INTO league_player_taxi_exits(league_id,player_id,exited_at)
    SELECT league_id,winner_id,exited_at FROM league_player_taxi_exits WHERE player_id=loser_id
    ON CONFLICT(league_id,player_id) DO UPDATE SET exited_at=LEAST(league_player_taxi_exits.exited_at,EXCLUDED.exited_at);
  INSERT INTO league_member_taxi_exits(league_id,member_id,player_id,exited_at)
    SELECT league_id,member_id,winner_id,exited_at FROM league_member_taxi_exits WHERE player_id=loser_id
    ON CONFLICT(league_id,member_id,player_id) DO UPDATE SET exited_at=LEAST(league_member_taxi_exits.exited_at,EXCLUDED.exited_at);
  DELETE FROM private.taxi_acquisition_context WHERE transaction_id=pg_current_xact_id() AND source='merge' AND related_id=loser_id;

  UPDATE dynasty_rankings SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE fantasypros_projection_rows SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE dynasty_news SET player_id = winner_id WHERE player_id = loser_id;
  UPDATE league_activity SET related_player_id = winner_id WHERE related_player_id = loser_id;

  DELETE FROM players WHERE id = loser_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.lineup_game_started(p_player_id uuid, p_game_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- A lineup slot locks once the player's game that day has started: the feed
  -- says so, its scheduled tip-off has passed, or a start time is recorded.
  WITH participation AS (
    SELECT game_id FROM player_game_stats WHERE player_id = p_player_id
    UNION
    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g
        ON g.game_date = p_game_date
       AND (
         ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
           AND NOT EXISTS (
             SELECT 1 FROM participation AS observed
             JOIN nba_games AS actual ON actual.id = observed.game_id
             WHERE actual.game_date = p_game_date
           ))
         OR EXISTS (
           SELECT 1 FROM participation AS stats
            WHERE stats.game_id = g.id
         )
       )
     WHERE p.id = p_player_id
       AND (
         g.status IN ('InProgress', 'Final')
         OR (g.game_time IS NOT NULL AND g.game_time <= now())
         OR (g.started_at IS NOT NULL AND g.started_at <= now())
       )
  )
$$;

CREATE OR REPLACE FUNCTION private.roster_status_game_started(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH participation AS (
    SELECT game_id FROM player_game_stats WHERE player_id = p_player_id
    UNION
    SELECT game_id FROM private.player_game_memberships WHERE player_id = p_player_id
  ), slate AS (
    SELECT (now() AT TIME ZONE 'America/New_York')::date AS today
  )
  SELECT EXISTS (
    SELECT 1
      FROM players AS p
      JOIN nba_games AS g ON (
        ((g.home_team = p.nba_team OR g.away_team = p.nba_team)
          AND NOT EXISTS (
            SELECT 1 FROM participation AS observed
            JOIN nba_games AS actual ON actual.id = observed.game_id
            WHERE actual.game_date = g.game_date
          ))
        OR EXISTS (
          SELECT 1 FROM participation AS stats
          WHERE stats.game_id = g.id
        )
      )
      CROSS JOIN slate
     WHERE p.id = p_player_id
       AND g.game_date IN (slate.today - 1, slate.today)
       AND (
         g.status = 'InProgress'
         OR (g.game_date = slate.today AND g.status = 'Final')
         OR (g.game_time <= now() AND (g.game_date = slate.today OR g.game_time >= now() - interval '12 hours'))
         OR (g.started_at <= now() AND (g.game_date = slate.today OR g.started_at >= now() - interval '12 hours'))
       )
  )
$$;
