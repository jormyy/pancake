-- Canonical SQL source for public.drop_player_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid, p_expected_league_season_id uuid, p_rookie_draft_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  __request_context jsonb;
BEGIN
  __request_context := private.request_begin('public.drop_player_atomic', jsonb_build_array(p_roster_player_id, p_expected_league_season_id, p_rookie_draft_id), NULL, NULL);
  IF (__request_context->>'replay')::boolean THEN RETURN; END IF;
  <<request_write>>
DECLARE
  v_rp roster_players%ROWTYPE;
  v_member league_members%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_league_id uuid;
  v_player_id uuid;
  v_member_id uuid;
  v_rows int;
  v_rookie_draft_id uuid;
BEGIN
  SELECT league_id, player_id, member_id
    INTO v_league_id, v_player_id, v_member_id
    FROM roster_players
   WHERE id = p_roster_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT draft.id INTO v_rookie_draft_id
    FROM drafts AS draft
    JOIN league_seasons AS season ON season.id = draft.league_season_id AND season.is_current
    JOIN leagues AS league ON league.id = draft.league_id AND league.status = 'drafting'
   WHERE draft.league_id = v_league_id
     AND draft.draft_type = 'snake' AND NOT draft.is_mock AND draft.status IN ('completed','cancelled')
   ORDER BY draft.created_at DESC LIMIT 1;
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(v_rookie_draft_id::text), 0);
    PERFORM 1 FROM drafts WHERE id = v_rookie_draft_id FOR UPDATE;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_member_id::text)
  );

  PERFORM pg_advisory_xact_lock(
    hashtext(v_league_id::text),
    hashtext(v_player_id::text)
  );

  SELECT *
    INTO v_rp
    FROM roster_players
   WHERE id = p_roster_player_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_league_season_id IS NOT NULL
     AND v_rp.league_season_id <> p_expected_league_season_id THEN
    RAISE EXCEPTION 'The roster season has changed. Refresh before dropping a player.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_rp.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found.'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_league.status NOT IN ('drafting'::league_status, 'active'::league_status, 'playoffs'::league_status, 'offseason'::league_status) THEN
    RAISE EXCEPTION 'Roster moves are only allowed during a draft or active/playoff season.'
      USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1
    FROM league_seasons AS season
   WHERE season.id = v_rp.league_season_id
     AND season.is_current = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Roster moves are only allowed for the current season.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT *
    INTO v_member
    FROM league_members
   WHERE id = v_rp.member_id
     AND user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF p_rookie_draft_id IS NOT NULL THEN
    IF p_expected_league_season_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM drafts
       WHERE id = p_rookie_draft_id
         AND league_id = v_rp.league_id
         AND league_season_id = v_rp.league_season_id
         AND draft_type = 'snake' AND NOT is_mock
         AND status IN ('in_progress', 'paused', 'completed', 'cancelled')
    ) THEN
      RAISE EXCEPTION 'The draft has changed. Refresh before trimming the roster.' USING ERRCODE = 'P0001';
    END IF;
    IF v_rp.is_on_ir OR v_rp.is_on_taxi OR (
      SELECT count(*) FROM roster_players
       WHERE league_id = v_rp.league_id AND league_season_id = v_rp.league_season_id
         AND member_id = v_rp.member_id AND NOT is_on_ir AND NOT is_on_taxi
    ) <= v_league.roster_size THEN
      RAISE EXCEPTION 'The active roster no longer needs this drop. Refresh the roster.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  DELETE FROM roster_players
   WHERE id = p_roster_player_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO waiver_wire_log (
    league_id,
    league_season_id,
    player_id,
    dropped_by_member_id
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.player_id,
    v_rp.member_id
  );

  INSERT INTO roster_transactions (
    league_id,
    league_season_id,
    member_id,
    player_id,
    transaction_type
  )
  VALUES (
    v_rp.league_id,
    v_rp.league_season_id,
    v_rp.member_id,
    v_rp.player_id,
    'fa_drop'
  );
  IF v_rookie_draft_id IS NOT NULL THEN
    PERFORM private.activate_rookie_draft_league_if_ready(v_rookie_draft_id);
  END IF;
END request_write;
  PERFORM private.request_finish(__request_context, 'null'::jsonb);
  RETURN;
END;
$function$;
