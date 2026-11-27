-- Canonical SQL source for public.make_rookie_selection_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.make_rookie_selection_atomic(
  p_draft_id uuid,
  p_member_id uuid,
  p_player_id uuid,
  p_destination text,
  p_drop_roster_player_ids uuid[] DEFAULT '{}',
  p_expected_overall_pick int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  __request_context jsonb;
  __request_result jsonb;
BEGIN
  __request_context := private.request_begin('public.make_rookie_selection_atomic',
    jsonb_build_array(p_draft_id, p_member_id, p_player_id, p_destination, p_drop_roster_player_ids, p_expected_overall_pick), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN __request_context->'result'; END IF;
  <<request_write>>
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_next snake_draft_picks%ROWTYPE;
  v_drop_ids uuid[] := ARRAY(SELECT DISTINCT unnest(COALESCE(p_drop_roster_player_ids, '{}')));
  v_drop_player_ids uuid[];
  v_drop roster_players%ROWTYPE;
  v_rookie roster_players%ROWTYPE;
  v_found int;
  v_active int;
  v_taxi int;
BEGIN
  IF p_destination IS NULL OR p_destination NOT IN ('active', 'taxi', 'drop') THEN
    RAISE EXCEPTION 'Choose where the rookie goes.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(array_agg(player_id), '{}') INTO v_drop_player_ids
    FROM roster_players WHERE id = ANY(v_drop_ids);
  PERFORM private.lock_roster_scope(v_draft.league_id, ARRAY[p_member_id], ARRAY[p_player_id] || v_drop_player_ids, p_draft_id);

  SELECT * INTO v_draft FROM drafts WHERE id = p_draft_id FOR UPDATE;
  SELECT * INTO v_next
    FROM snake_draft_picks
   WHERE draft_id = p_draft_id AND player_id IS NULL AND skipped_at IS NULL
   ORDER BY overall_pick
   LIMIT 1;
  IF p_expected_overall_pick IS NOT NULL AND (v_next.id IS NULL OR v_next.overall_pick <> p_expected_overall_pick) THEN
    RAISE EXCEPTION 'Pick % was already made. Refresh the board.', p_expected_overall_pick USING ERRCODE = 'PA013';
  END IF;

  IF v_draft.is_mock THEN
    IF cardinality(v_drop_ids) > 0 THEN
      RAISE EXCEPTION 'Practice drafts do not change rosters.' USING ERRCODE = '22023';
    END IF;
    __request_result := private.make_snake_pick_atomic_internal(p_draft_id, p_member_id, p_player_id, false, false)
      || jsonb_build_object('destination', p_destination, 'dropped', '[]'::jsonb);
    EXIT request_write;
  END IF;

  SELECT * INTO v_league FROM leagues WHERE id = v_draft.league_id;
  IF p_player_id = ANY(v_drop_player_ids) THEN
    RAISE EXCEPTION 'Choose Drop rookie to release the player you are drafting.' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found
    FROM roster_players
   WHERE id = ANY(v_drop_ids)
     AND league_id = v_draft.league_id
     AND league_season_id = v_draft.league_season_id
     AND member_id = p_member_id;
  IF v_found <> cardinality(v_drop_ids) THEN
    RAISE EXCEPTION 'A player you chose to drop is no longer on your roster. Refresh and try again.' USING ERRCODE = 'PA010';
  END IF;

  __request_result := private.make_snake_pick_atomic_internal(p_draft_id, p_member_id, p_player_id, false, p_destination = 'taxi');

  FOR v_drop IN
    SELECT * FROM roster_players WHERE id = ANY(v_drop_ids) ORDER BY id FOR UPDATE
  LOOP
    PERFORM private.release_roster_player_to_waivers(
      v_drop.id, v_drop.league_id, v_drop.league_season_id, v_drop.member_id, v_drop.player_id, 'fa_drop');
  END LOOP;

  IF p_destination = 'drop' THEN
    SELECT * INTO v_rookie
      FROM roster_players
     WHERE league_id = v_draft.league_id AND league_season_id = v_draft.league_season_id
       AND member_id = p_member_id AND player_id = p_player_id
     FOR UPDATE;
    PERFORM private.release_roster_player_to_waivers(
      v_rookie.id, v_rookie.league_id, v_rookie.league_season_id, v_rookie.member_id, v_rookie.player_id, 'fa_drop');
  END IF;

  SELECT count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi), count(*) FILTER (WHERE is_on_taxi)
    INTO v_active, v_taxi
    FROM roster_players
   WHERE league_id = v_draft.league_id AND league_season_id = v_draft.league_season_id AND member_id = p_member_id;
  IF v_active > v_league.roster_size THEN
    RAISE EXCEPTION 'Your active roster would be % over the limit of %. Choose a player to drop.', v_active - v_league.roster_size, v_league.roster_size
      USING ERRCODE = 'PA012';
  END IF;
  IF v_taxi > v_league.taxi_slots THEN
    RAISE EXCEPTION 'Your taxi squad would be % over the limit of %. Choose a player to drop.', v_taxi - v_league.taxi_slots, v_league.taxi_slots
      USING ERRCODE = 'PA012';
  END IF;

  IF COALESCE((__request_result->>'completed')::boolean, false) AND NOT COALESCE((__request_result->>'activated')::boolean, false) THEN
    __request_result := __request_result || jsonb_build_object('activated', private.activate_rookie_draft_league_if_ready(p_draft_id));
  END IF;
  __request_result := __request_result || jsonb_build_object(
    'destination', p_destination,
    'dropped', to_jsonb(v_drop_ids),
    'active_count', v_active,
    'taxi_count', v_taxi,
    'roster_size', v_league.roster_size,
    'taxi_slots', v_league.taxi_slots
  );
END request_write;
  PERFORM private.request_finish(__request_context, __request_result);
  RETURN __request_result;
END;
$$;
