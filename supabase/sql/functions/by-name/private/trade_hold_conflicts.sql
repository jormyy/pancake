-- Canonical SQL source for private.trade_hold_conflicts.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_hold_conflicts(
  p_league_id uuid,
  p_season_id uuid,
  p_member_id uuid,
  p_extra jsonb DEFAULT NULL,
  p_remedy text DEFAULT 'drop',
  p_include_trade_id uuid DEFAULT NULL,
  p_commit_trade boolean DEFAULT false,
  p_actor_member_id uuid DEFAULT NULL,
  p_baseline jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_league leagues%ROWTYPE;
  v_conflicts jsonb := '[]'::jsonb;
  v_trade_id uuid;
  v_after record;
  v_before record;
  v_base_ids uuid[];
  v_after_ids uuid[];
  v_baseline_hold jsonb;
  v_conflict boolean;
BEGIN
  SELECT * INTO v_league FROM leagues WHERE id = p_league_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(array_agg(trade.id), '{}'::uuid[])
    INTO v_base_ids
    FROM trades trade
    JOIN trade_participants participant
      ON participant.trade_id = trade.id
     AND participant.member_id = p_member_id
   WHERE trade.league_id = p_league_id
     AND trade.league_season_id = p_season_id
     AND trade.status = 'accepted';

  v_after_ids := v_base_ids;
  IF p_include_trade_id IS NOT NULL AND p_commit_trade AND NOT p_include_trade_id = ANY(v_after_ids) THEN
    v_after_ids := v_after_ids || p_include_trade_id;
  END IF;

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
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids, p_extra);
    v_baseline_hold := p_baseline->(v_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id, false, p_remedy, p_actor_member_id);
    END IF;
  END LOOP;

  IF p_include_trade_id IS NOT NULL AND NOT p_commit_trade THEN
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids || p_include_trade_id, p_extra);
    v_baseline_hold := p_baseline->(p_include_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, p_include_trade_id, false, p_remedy, p_actor_member_id);
    END IF;
  END IF;

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
       AND (p_include_trade_id IS NULL OR trade.id <> p_include_trade_id)
     ORDER BY trade.id
  LOOP
    SELECT count(*) FILTER (WHERE NOT on_ir AND NOT on_taxi) AS active,
           count(*) FILTER (WHERE on_ir) AS ir,
           count(*) FILTER (WHERE on_taxi) AS taxi
      INTO v_after
      FROM private.trade_hold_roster(p_league_id, p_season_id, p_member_id, v_after_ids || v_trade_id, p_extra);
    v_baseline_hold := p_baseline->(v_trade_id::text);
    IF v_baseline_hold IS NOT NULL THEN
      SELECT (v_baseline_hold->>'active')::bigint AS active,
             (v_baseline_hold->>'ir')::bigint AS ir,
             (v_baseline_hold->>'taxi')::bigint AS taxi
        INTO v_before;
      v_conflict := GREATEST(0, v_after.active - v_league.roster_size) > GREATEST(0, v_before.active - v_league.roster_size)
        OR GREATEST(0, v_after.ir - v_league.ir_slots) > GREATEST(0, v_before.ir - v_league.ir_slots)
        OR GREATEST(0, v_after.taxi - v_league.taxi_slots) > GREATEST(0, v_before.taxi - v_league.taxi_slots);
    ELSE
      v_conflict := v_after.active > v_league.roster_size
        OR v_after.ir > v_league.ir_slots
        OR v_after.taxi > v_league.taxi_slots;
    END IF;
    IF v_conflict THEN
      v_conflicts := v_conflicts || private.trade_hold_conflict(
        p_league_id, p_season_id, p_member_id, v_trade_id, true, p_remedy, p_actor_member_id);
    END IF;
  END LOOP;

  RETURN v_conflicts;
END;
$$;
