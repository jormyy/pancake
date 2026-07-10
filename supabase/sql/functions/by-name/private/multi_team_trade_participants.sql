-- Canonical SQL source for private.multi_team_trade_participants.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.multi_team_trade_participants(
  p_proposer_member_id uuid,
  p_participant_member_ids uuid[]
)
RETURNS TABLE (sort_order int, member_id uuid)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT retained.sort_order, retained.member_id
    FROM (
      SELECT DISTINCT ON (candidate.member_id)
        candidate.sort_order,
        candidate.member_id
        FROM (
          SELECT 0 AS sort_order, p_proposer_member_id AS member_id
          UNION ALL
          SELECT ordinality::int, participant.member_id
            FROM unnest(COALESCE(p_participant_member_ids, ARRAY[]::uuid[]))
              WITH ORDINALITY AS participant(member_id, ordinality)
           WHERE participant.member_id <> p_proposer_member_id
        ) AS candidate
       ORDER BY candidate.member_id, candidate.sort_order
    ) AS retained
   ORDER BY retained.sort_order, retained.member_id;
$$;
