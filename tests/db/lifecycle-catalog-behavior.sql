BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000030001', 'authenticated', 'authenticated',
  'lifecycle-catalog@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-000000030001', 'lifecycle_catalog_user', 'Lifecycle Catalog User')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.leagues (id, name, slug, commissioner_id, status)
VALUES (
  '00000000-0000-0000-0000-000000030101', 'Lifecycle Catalog Test',
  'lifecycle-catalog-test', '00000000-0000-0000-0000-000000030001', 'active'
);

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES (
  '00000000-0000-0000-0000-000000030201',
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030001', 'commissioner', 'Catalog Team'
);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-000000030002', 'authenticated', 'authenticated', 'trade-b@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000030003', 'authenticated', 'authenticated', 'trade-c@example.test', 'x', now(), '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name)
VALUES
  ('00000000-0000-0000-0000-000000030002', 'lifecycle_trade_b', 'Trade B'),
  ('00000000-0000-0000-0000-000000030003', 'lifecycle_trade_c', 'Trade C')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-000000030202', '00000000-0000-0000-0000-000000030101', '00000000-0000-0000-0000-000000030002', 'manager', 'Trade B'),
  ('00000000-0000-0000-0000-000000030203', '00000000-0000-0000-0000-000000030101', '00000000-0000-0000-0000-000000030003', 'manager', 'Trade C');

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES (
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030101', 2099, true
);

INSERT INTO public.players (id, first_name, last_name, nba_team, position, years_exp, eligible_positions)
VALUES (
  '00000000-0000-0000-0000-000000030401', 'Due', 'Waiver', 'FA', 'PG', 1, ARRAY['PG']
);

INSERT INTO public.waiver_wire_log (
  id, league_id, league_season_id, player_id, dropped_by_member_id, clears_at
)
VALUES (
  '00000000-0000-0000-0000-000000030501',
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030401',
  '00000000-0000-0000-0000-000000030201', now() - interval '1 minute'
);

INSERT INTO public.trades (
  league_id, league_season_id, proposer_member_id, recipient_member_id,
  status, proposed_at, accepted_at, veto_window_expires_at
)
SELECT
  '00000000-0000-0000-0000-000000030101',
  '00000000-0000-0000-0000-000000030301',
  '00000000-0000-0000-0000-000000030202',
  '00000000-0000-0000-0000-000000030203',
  'accepted', now() + make_interval(secs => series), now(), now() + interval '1 day'
FROM generate_series(1, 41) AS series;

WITH personal_trade AS (
  INSERT INTO public.trades (
    league_id, league_season_id, proposer_member_id, recipient_member_id,
    status, proposed_at
  ) VALUES (
    '00000000-0000-0000-0000-000000030101',
    '00000000-0000-0000-0000-000000030301',
    '00000000-0000-0000-0000-000000030202',
    '00000000-0000-0000-0000-000000030201',
    'pending', now() - interval '1 day'
  )
  RETURNING id
)
INSERT INTO public.trade_participants (trade_id, member_id, sort_order, is_initiator, accepted_at)
SELECT id, '00000000-0000-0000-0000-000000030202'::uuid, 0, true, now() FROM personal_trade
UNION ALL
SELECT id, '00000000-0000-0000-0000-000000030201'::uuid, 1, false, NULL FROM personal_trade;

DO $$
DECLARE
  v_visible_count int;
  v_personal_count int;
  v_pending_count bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000030001', true);
  SET LOCAL ROLE authenticated;

  SELECT count(*), count(*) FILTER (WHERE recipient_member_id = '00000000-0000-0000-0000-000000030201')
    INTO v_visible_count, v_personal_count
    FROM public.get_trade_page_refs(
      '00000000-0000-0000-0000-000000030201',
      '00000000-0000-0000-0000-000000030101', 40
    ) AS ref
    JOIN public.trades AS trade ON trade.id = ref.trade_id;
  SELECT public.get_pending_trade_count(
    '00000000-0000-0000-0000-000000030201',
    '00000000-0000-0000-0000-000000030101'
  ) INTO v_pending_count;

  IF v_visible_count <> 40 OR v_personal_count <> 1 THEN
    RAISE EXCEPTION 'Visible trade page lost personal trade: total %, personal %', v_visible_count, v_personal_count;
  END IF;
  IF v_pending_count <> 1 THEN
    RAISE EXCEPTION 'Pending trade count expected 1, found %', v_pending_count;
  END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.roster_players (
      league_id, league_season_id, member_id, player_id, acquired_via
    ) VALUES (
      '00000000-0000-0000-0000-000000030101',
      '00000000-0000-0000-0000-000000030301',
      '00000000-0000-0000-0000-000000030201',
      '00000000-0000-0000-0000-000000030401', 'free_agent'
    );
    RAISE EXCEPTION 'Due waiver player was acquired as a free agent';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM NOT LIKE 'This player is on waivers%' THEN RAISE; END IF;
  END;

  INSERT INTO public.roster_players (
    league_id, league_season_id, member_id, player_id, acquired_via
  ) VALUES (
    '00000000-0000-0000-0000-000000030101',
    '00000000-0000-0000-0000-000000030301',
    '00000000-0000-0000-0000-000000030201',
    '00000000-0000-0000-0000-000000030401', 'waiver'
  );

  UPDATE public.leagues
     SET status = 'archived', deleted_at = now(), deleted_by = commissioner_id
   WHERE id = '00000000-0000-0000-0000-000000030101';

  BEGIN
    INSERT INTO public.league_seasons (league_id, season_year, is_current)
    VALUES ('00000000-0000-0000-0000-000000030101', 2100, false);
    RAISE EXCEPTION 'Deleted league accepted a new season';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'Deleted leagues cannot be advanced.' THEN RAISE; END IF;
  END;
END $$;

DO $$
DECLARE
  v_avatar_policies int;
BEGIN
  SELECT count(*) INTO v_avatar_policies
    FROM pg_policies
   WHERE schemaname = 'storage'
     AND tablename = 'objects'
     AND policyname IN (
       'avatars_read_public', 'avatars_insert_own',
       'avatars_update_own', 'avatars_delete_own'
     );
  IF v_avatar_policies <> 4 THEN
    RAISE EXCEPTION 'Expected four avatar policies, found %', v_avatar_policies;
  END IF;

  IF to_regclass('public.idx_trades_due_accepted_queue') IS NULL THEN
    RAISE EXCEPTION 'Due accepted-trade queue index is missing';
  END IF;
  IF to_regclass('public.idx_trade_vetos_trade_member') IS NOT NULL THEN
    RAISE EXCEPTION 'Duplicate trade veto index still exists';
  END IF;
END $$;

DO $$
DECLARE
  v_page_oid regprocedure := 'public.get_trade_page_refs(uuid,uuid,integer,text)'::regprocedure;
  v_accept_definition text;
  v_complete_definition text;
  v_create_definition text;
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid = 'public.trade_items'::regclass
       AND attname IN ('from_member_id', 'to_member_id')
       AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'Trade item routes must be non-null catalog invariants';
  END IF;

  IF to_regprocedure('public.get_trades_for_member(uuid,uuid,integer,integer)') IS NOT NULL
     OR to_regprocedure('public.get_trades_for_member_page(uuid,uuid,integer,boolean,boolean,timestamp with time zone,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Superseded trade feed function still exists';
  END IF;
  IF has_function_privilege('anon', v_page_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_page_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Trade feed function grants are incorrect';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_proc
     WHERE oid = v_page_oid
       AND (prosecdef OR NOT proconfig @> ARRAY['search_path=public'])
  ) THEN
    RAISE EXCEPTION 'Trade feed must remain invoker security with an explicit search path';
  END IF;
  IF has_function_privilege('anon', 'private.parse_multi_team_trade_items(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.parse_multi_team_trade_items(jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.parse_multi_team_trade_items(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.multi_team_trade_participants(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.multi_team_trade_participants(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'private.multi_team_trade_participants(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Private trade parsing helpers are client executable';
  END IF;
  IF to_regprocedure('public.accept_multi_team_trade_atomic(uuid,uuid,uuid[])') IS NOT NULL
     OR to_regprocedure('private.accept_trade_participant_atomic(uuid,uuid,uuid[],boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'Superseded trade acceptance entrypoint still exists';
  END IF;

  SELECT pg_get_functiondef('private.accept_trade_participant_atomic(uuid,uuid,uuid[])'::regprocedure)
    INTO v_accept_definition;
  SELECT pg_get_functiondef('public.complete_accepted_trade_atomic(uuid)'::regprocedure)
    INTO v_complete_definition;
  SELECT pg_get_functiondef('private.create_multi_team_trade_offer(uuid,uuid,uuid,uuid[],jsonb,text,timestamptz)'::regprocedure)
    INTO v_create_definition;
  IF v_accept_definition ILIKE '%COALESCE(item.from_member_id%'
     OR v_complete_definition ILIKE '%COALESCE(item.from_member_id%'
     OR v_complete_definition ILIKE '%COALESCE(v_item.to_member_id%' THEN
    RAISE EXCEPTION 'Trade execution still has legacy side-based route fallback';
  END IF;
  IF v_create_definition ILIKE '%CREATE TEMP TABLE%'
     OR v_create_definition NOT ILIKE '%jsonb_array_length(p_items) > 100%' THEN
    RAISE EXCEPTION 'Multi-team trade creation is not bounded and temp-table free';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.trade_items'::regclass
       AND conname IN ('trade_items_from_participant_fkey', 'trade_items_to_participant_fkey')
       AND contype = 'f'
       AND condeferrable
    GROUP BY conrelid
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'Trade routes are not deferred participant foreign keys';
  END IF;

  BEGIN
    INSERT INTO public.trade_items (trade_id, side, from_member_id, to_member_id, faab_amount)
    SELECT trade.id, 'proposer',
      '00000000-0000-0000-0000-000000030202',
      '00000000-0000-0000-0000-000000030203', 1
      FROM public.trades AS trade
     WHERE trade.recipient_member_id = '00000000-0000-0000-0000-000000030201'
     LIMIT 1;
    SET CONSTRAINTS trade_items_to_participant_fkey IMMEDIATE;
    RAISE EXCEPTION 'Trade item accepted a route to a nonparticipant';
  EXCEPTION WHEN foreign_key_violation THEN
    SET CONSTRAINTS trade_items_to_participant_fkey DEFERRED;
  END;
END $$;

DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT procedure.oid, procedure.proname
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname = ANY(ARRAY[
         'propose_trade_atomic', 'accept_trade_atomic',
         'reject_trade_atomic', 'withdraw_trade_atomic', 'complete_accepted_trade_atomic',
         'veto_trade_atomic', 'expire_trade_completion_failure_atomic', 'process_due_accepted_trades_atomic',
         'add_trade_block_item_atomic', 'remove_trade_block_item_atomic', 'create_waiver_claim_atomic',
         'cancel_waiver_claim_atomic', 'process_next_waiver_claim_atomic', 'process_due_waiver_claims_atomic',
         'create_auction_nomination_atomic', 'start_auction_draft_atomic', 'place_auction_bid_atomic',
         'close_auction_nomination_atomic', 'close_expired_auction_nominations_atomic',
         'process_expired_snake_picks_atomic', 'process_expired_snake_pick_atomic',
         'withdraw_auction_nomination_atomic', 'make_snake_pick_atomic', 'auto_pick_snake_pick_atomic',
         'commissioner_snake_pick_atomic', 'start_rookie_draft_atomic', 'reseed_rookie_draft_picks_atomic',
         'advance_season_atomic', 'toggle_ir_atomic', 'toggle_taxi_atomic', 'expire_waiver_wire_logs',
         'clear_ineligible_taxi_players', 'replace_regular_season_matchups_atomic',
         'generate_playoff_bracket_atomic', 'advance_playoff_bracket_atomic', 'try_live_poll_lease',
         'release_live_poll_lease', 'invoke_edge_function', 'invoke_edge_function_at_et_time',
         'invoke_projection_sync_if_due', 'merge_players', 'merge_duplicate_players',
         'count_final_games_missing_stats'
       ])
  LOOP
    IF has_function_privilege('anon', v_function.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Service-only function % has incorrect final privileges', v_function.proname;
    END IF;
  END LOOP;
END $$;

ROLLBACK;
