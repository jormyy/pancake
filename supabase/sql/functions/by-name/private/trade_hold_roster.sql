-- Canonical SQL source for private.trade_hold_roster.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_hold_roster(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_trade_ids uuid[],
  p_extra jsonb DEFAULT NULL
)
RETURNS TABLE(player_id uuid, on_ir boolean, on_taxi boolean)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH commitments AS (
    SELECT trade.id, participant.drop_player_ids, participant.roster_moves
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.id = ANY(p_trade_ids)
  ), extra_drop AS (
    SELECT value::uuid AS player_id
      FROM jsonb_array_elements_text(COALESCE(p_extra->'dropPlayerIds', '[]'::jsonb)) value
     WHERE value IS NOT NULL
  ), retained AS (
    SELECT roster.player_id,
      CASE WHEN move.value IS NULL THEN roster.is_on_ir ELSE move.value->>'destination' = 'ir' END AS on_ir,
      CASE WHEN move.value IS NULL THEN roster.is_on_taxi ELSE move.value->>'destination' = 'taxi' END AS on_taxi
      FROM roster_players roster
      LEFT JOIN LATERAL (
        SELECT value
          FROM commitments, jsonb_array_elements(commitments.roster_moves)
         WHERE value->>'playerId' = roster.player_id::text
         LIMIT 1
      ) move ON true
     WHERE roster.league_season_id = p_season_id
       AND roster.member_id = p_member_id
       AND NOT EXISTS (SELECT 1 FROM commitments WHERE roster.player_id = ANY(commitments.drop_player_ids))
       AND NOT EXISTS (
         SELECT 1
           FROM commitments
           JOIN trade_items item ON item.trade_id = commitments.id
          WHERE item.from_member_id = p_member_id
            AND item.player_id = roster.player_id)
  ), incoming AS (
    SELECT item.player_id, item.to_ir AS on_ir, item.to_taxi OR roster.is_on_taxi AS on_taxi
      FROM commitments
      JOIN trade_items item ON item.trade_id = commitments.id AND item.to_member_id = p_member_id
      JOIN roster_players roster ON roster.league_season_id = p_season_id AND roster.player_id = item.player_id
  ), extra_add AS (
    SELECT (p_extra->>'addPlayerId')::uuid AS player_id,
      COALESCE((p_extra->>'toIr')::boolean, false) AS on_ir,
      COALESCE((p_extra->>'toTaxi')::boolean, false) AS on_taxi
     WHERE p_extra IS NOT NULL
       AND NULLIF(p_extra->>'addPlayerId', '') IS NOT NULL
  )
  SELECT player_id, on_ir, on_taxi FROM retained
   WHERE NOT player_id IN (SELECT player_id FROM extra_drop)
  UNION ALL
  SELECT player_id, on_ir, on_taxi FROM incoming
   WHERE NOT player_id IN (SELECT player_id FROM extra_drop)
  UNION ALL
  SELECT player_id, on_ir, on_taxi FROM extra_add
$$;
