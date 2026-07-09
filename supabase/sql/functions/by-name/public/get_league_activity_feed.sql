-- Canonical SQL source for public.get_league_activity_feed.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_league_activity_feed(
  p_league_id uuid,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  member_id uuid,
  target_member_id uuid,
  team_name text,
  target_team_name text,
  player_id uuid,
  player_name text,
  player_position text,
  eligible_positions text[],
  nba_id text,
  transaction_type text,
  occurred_at timestamptz,
  is_system boolean,
  title text,
  body text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH current_season AS (
    SELECT season.id
      FROM league_seasons AS season
     WHERE season.league_id = p_league_id
       AND season.is_current = true
     LIMIT 1
  ),
  feed AS (
    SELECT
      tx.id,
      tx.member_id,
      NULL::uuid AS target_member_id,
      member.team_name::text AS team_name,
      NULL::text AS target_team_name,
      tx.player_id,
      player.display_name::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      tx.transaction_type::text AS transaction_type,
      tx.occurred_at,
      false AS is_system,
      NULL::text AS title,
      NULL::text AS body
    FROM roster_transactions AS tx
    JOIN current_season ON current_season.id = tx.league_season_id
    LEFT JOIN league_members AS member ON member.id = tx.member_id
    LEFT JOIN players AS player ON player.id = tx.player_id
    WHERE tx.league_id = p_league_id
      AND tx.transaction_type IN ('fa_add', 'fa_drop', 'waiver_add', 'waiver_drop', 'trade_in', 'trade_out', 'draft_won', 'carry_over')

    UNION ALL

    SELECT
      activity.id,
      activity.actor_member_id AS member_id,
      activity.target_member_id,
      COALESCE(actor.team_name, 'League')::text AS team_name,
      target.team_name::text AS target_team_name,
      activity.related_player_id AS player_id,
      COALESCE(player.display_name, activity.title)::text AS player_name,
      player.position::text AS player_position,
      player.eligible_positions::text[] AS eligible_positions,
      player.nba_id::text AS nba_id,
      activity.event_type::text AS transaction_type,
      activity.created_at AS occurred_at,
      true AS is_system,
      activity.title,
      activity.body
    FROM league_activity AS activity
    JOIN current_season
      ON activity.league_season_id = current_season.id
      OR activity.league_season_id IS NULL
    LEFT JOIN league_members AS actor ON actor.id = activity.actor_member_id
    LEFT JOIN league_members AS target ON target.id = activity.target_member_id
    LEFT JOIN players AS player ON player.id = activity.related_player_id
    WHERE activity.league_id = p_league_id
  )
  SELECT
    feed.id,
    feed.member_id,
    feed.target_member_id,
    feed.team_name,
    feed.target_team_name,
    feed.player_id,
    feed.player_name,
    feed.player_position,
    feed.eligible_positions,
    feed.nba_id,
    feed.transaction_type,
    feed.occurred_at,
    feed.is_system,
    feed.title,
    feed.body
  FROM feed
  ORDER BY feed.occurred_at DESC, feed.id DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$$;
