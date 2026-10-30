-- Canonical SQL source for private.activate_rookie_draft_league_if_ready.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.activate_rookie_draft_league_if_ready(
  p_draft_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_draft drafts%ROWTYPE;
  v_league leagues%ROWTYPE;
  v_current_season league_seasons%ROWTYPE;
  v_rows int;
  v_unfilled_picks int;
  v_deadline boolean;
  v_member record;
  v_roster record;
  v_active int;
BEGIN
  -- Serialize with picks before taking draft, league or season row locks.
  PERFORM pg_advisory_xact_lock(hashtext(p_draft_id::text), 0);

  SELECT *
    INTO v_draft
    FROM drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.is_mock THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_league
    FROM leagues
   WHERE id = v_draft.league_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'League not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_draft.draft_type <> 'snake'::draft_type OR v_draft.status NOT IN ('completed'::draft_status,'cancelled'::draft_status) THEN
    RETURN false;
  END IF;

  SELECT *
    INTO v_current_season
    FROM league_seasons
   WHERE league_id = v_draft.league_id
     AND is_current = true
   FOR UPDATE;

  IF NOT FOUND OR v_draft.league_season_id <> v_current_season.id THEN
    RETURN false;
  END IF;

  SELECT count(*)
    INTO v_unfilled_picks
    FROM snake_draft_picks
   WHERE draft_id = v_draft.id
     AND player_id IS NULL
     AND skipped_at IS NULL;

  IF v_unfilled_picks > 0 AND v_draft.status<>'cancelled' THEN
    RETURN false;
  END IF;

  PERFORM 1
    FROM drafts AS current_draft
   WHERE current_draft.league_id = v_draft.league_id
     AND current_draft.league_season_id = v_current_season.id
     AND current_draft.id <> v_draft.id
     AND current_draft.draft_type = 'snake'::draft_type
     AND current_draft.is_mock = false
     AND current_draft.status IN (
       'pending'::draft_status,
       'in_progress'::draft_status,
       'paused'::draft_status
     )
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN false;
  END IF;

  v_deadline := COALESCE(private.draft_timer_opening_night_cutoff(v_current_season.season_year) <= now(), false);
  IF v_league.status = 'drafting' AND v_deadline THEN
    FOR v_member IN SELECT id FROM league_members WHERE league_id = v_draft.league_id ORDER BY id LOOP
      IF NOT pg_try_advisory_xact_lock(hashtext(v_draft.league_id::text), hashtext(v_member.id::text)) THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_active FROM roster_players
        WHERE league_season_id = v_current_season.id AND member_id = v_member.id
          AND NOT is_on_ir AND NOT is_on_taxi;
      FOR v_roster IN
        SELECT roster.id, roster.player_id FROM roster_players AS roster
          JOIN snake_draft_picks AS pick ON pick.draft_id = v_draft.id
            AND pick.member_id = roster.member_id AND pick.player_id = roster.player_id
          JOIN players AS player ON player.id = roster.player_id AND player.years_exp = 0
        WHERE roster.league_season_id = v_current_season.id AND roster.member_id = v_member.id
          AND NOT EXISTS(SELECT 1 FROM private.locked_assets(v_draft.league_id,v_current_season.id,v_member.id) locked
            WHERE locked.asset_kind='player' AND locked.asset_id=roster.player_id)
          AND roster.acquired_via = 'draft' AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
        ORDER BY pick.overall_pick DESC, roster.id FOR UPDATE OF roster SKIP LOCKED
      LOOP
        EXIT WHEN v_active <= v_league.roster_size;
        IF private.can_acquire_draft_taxi(v_draft.league_id, v_current_season.id, v_member.id,
          v_roster.player_id, v_draft.id, v_roster.id) THEN
          PERFORM private.authorize_taxi_acquisition(v_draft.league_id, v_current_season.id,
            v_member.id, v_roster.player_id, 'draft', v_draft.id);
          UPDATE roster_players SET is_on_taxi = true WHERE id = v_roster.id;
          INSERT INTO roster_transactions(league_id, league_season_id, member_id, player_id, transaction_type)
          VALUES(v_draft.league_id, v_current_season.id, v_member.id, v_roster.player_id, 'taxi_designate');
          v_active := v_active - 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  PERFORM 1
    FROM league_seasons AS season
    JOIN league_members AS member
      ON member.league_id = v_draft.league_id
    LEFT JOIN roster_players AS roster
      ON roster.league_id = v_draft.league_id
     AND roster.league_season_id = season.id
     AND roster.member_id = member.id
     AND roster.is_on_ir = false
     AND roster.is_on_taxi = false
   WHERE season.id = v_current_season.id
   GROUP BY member.id
  HAVING count(roster.id) > v_league.roster_size
   LIMIT 1;

  IF FOUND AND NOT v_deadline THEN
    RETURN false;
  END IF;

  UPDATE leagues
     SET status = 'active'
   WHERE id = v_draft.league_id
     AND status = 'drafting';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$$;
