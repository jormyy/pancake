-- Canonical SQL source for private.parse_multi_team_trade_items.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.parse_multi_team_trade_items(p_items jsonb)
RETURNS TABLE (
  sort_order int,
  from_member_id uuid,
  to_member_id uuid,
  player_id uuid,
  pick_id uuid,
  faab_amount int
)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT
    ordinality::int,
    NULLIF(item->>'fromMemberId', '')::uuid,
    NULLIF(item->>'toMemberId', '')::uuid,
    NULLIF(item->>'playerId', '')::uuid,
    NULLIF(item->>'pickId', '')::uuid,
    COALESCE(NULLIF(item->>'faabAmount', '')::int, 0)
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS entry(item, ordinality);
$$;
