-- Keep the hosted database lint-clean without changing gameplay behavior.
--
-- These functions intentionally assign row variables to drive FOUND checks, or
-- keep compatibility parameters in stable RPC signatures. Supabase DB lint
-- reports those as unread. This forward migration preserves the current
-- definitions and inserts explicit no-op reads so future lint gates stay clean.

DO $$
DECLARE
  v_sql text;
  v_original text;
BEGIN
  SELECT pg_get_functiondef('public.add_free_agent_atomic(uuid, uuid, uuid)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not add player - you may not have permission for this league.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT id$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch add_free_agent_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.auto_set_lineup_atomic_unchecked(uuid, uuid, uuid, date, jsonb)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch auto_set_lineup_atomic_unchecked for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.set_player_slot_moves_atomic_unchecked(uuid, uuid, uuid, date, integer, jsonb)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this lineup.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch set_player_slot_moves_atomic_unchecked for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.create_waiver_claim_atomic(uuid, uuid, uuid, uuid, uuid)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT id$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT id$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch create_waiver_claim_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.drop_player_atomic(uuid)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS ($old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not drop player - you may not have permission or they are no longer on your roster.'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM v_member.id;

  IF EXISTS ($new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch drop_player_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.toggle_ir_atomic(uuid, boolean, uuid)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch toggle_ir_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.toggle_taxi_atomic(uuid, boolean, uuid)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_league$old$,
$new$  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not authorized to modify this roster'
      USING ERRCODE = '42501';
  END IF;

  PERFORM v_member.id;

  SELECT *
    INTO v_league$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch toggle_taxi_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.join_league_by_invite_code(text, text)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  SELECT count(*)$old$,
$new$  IF FOUND THEN
    RAISE EXCEPTION 'You are already in this league.';
  END IF;

  PERFORM v_existing;

  SELECT count(*)$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch join_league_by_invite_code for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.process_next_waiver_claim_atomic(date)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$BEGIN
  SELECT wc.league_id, wc.league_season_id$old$,
$new$BEGIN
  PERFORM p_process_date;

  SELECT wc.league_id, wc.league_season_id$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch process_next_waiver_claim_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;

  SELECT pg_get_functiondef('public.expire_trade_completion_failure_atomic(uuid, text)'::regprocedure)
    INTO v_sql;
  v_original := v_sql;
  v_sql := replace(
    v_sql,
$old$BEGIN
  SELECT *$old$,
$new$BEGIN
  PERFORM p_reason;

  SELECT *$new$
  );
  IF v_sql = v_original THEN
    RAISE EXCEPTION 'Could not patch expire_trade_completion_failure_atomic for DB lint compatibility.';
  END IF;
  EXECUTE v_sql;
END $$;
