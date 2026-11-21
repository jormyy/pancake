-- Canonical SQL source for private.trade_hold_counts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_hold_counts(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_extra jsonb DEFAULT NULL
)
RETURNS TABLE(trade_id uuid, active int, ir int, taxi int)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_base_ids uuid[];
  v_trade_id uuid;
  v_counts record;
BEGIN
  SELECT COALESCE(array_agg(trade.id), '{}'::uuid[])
    INTO v_base_ids
    FROM trades trade
    JOIN trade_participants participant
      ON participant.trade_id = trade.id
     AND participant.member_id = p_member_id
   WHERE trade.league_id = p_league_id
     AND trade.league_season_id = p_season_id
     AND trade.status = 'accepted';

  FOR v_trade_id IN
    SELECT trade.id
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.league_id = p_league_id
       AND trade.league_season_id = p_season_id
       AND trade.status = 'accepted'
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_counts
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_base_ids, p_extra);
    trade_id := v_trade_id;
    active := v_counts.active;
    ir := v_counts.ir;
    taxi := v_counts.taxi;
    RETURN NEXT;
  END LOOP;

  FOR v_trade_id IN
    SELECT trade.id
      FROM trades trade
      JOIN trade_participants participant
        ON participant.trade_id = trade.id
       AND participant.member_id = p_member_id
     WHERE trade.league_id = p_league_id
       AND trade.league_season_id = p_season_id
       AND trade.status = 'pending'
       AND participant.accepted_at IS NOT NULL
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_counts
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_base_ids || v_trade_id, p_extra);
    trade_id := v_trade_id;
    active := v_counts.active;
    ir := v_counts.ir;
    taxi := v_counts.taxi;
    RETURN NEXT;
  END LOOP;
END;
$$;
