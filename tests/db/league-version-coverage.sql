\set ON_ERROR_STOP on
\getenv version_db_port PANCAKE_TEST_DB_PORT
\if :{?version_db_port}
\else
  \set version_db_port 59122
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'version_db_port' AS version_local \gset
\if :version_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the private loopback version test database.'; END $$;
\endif
BEGIN;
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE version_functions AS
  SELECT procedure.oid,namespace.nspname AS schema_name,procedure.proname,procedure.prosrc
  FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
  WHERE namespace.nspname IN ('public','private','analytics') AND procedure.prokind='f';
CREATE TEMP TABLE version_worker_rpcs(path text,function_name text);
INSERT INTO version_worker_rpcs VALUES
  ('supabase/functions/_shared/backfillJobs.ts','invoke_edge_function'),
  ('supabase/functions/_shared/bbrefBackfill.ts','publish_nba_schedule_atomic'),
  ('supabase/functions/_shared/cdnBackfill.ts','rebuild_nba_calendar_atomic'),
  ('supabase/functions/_shared/gameIdentity.ts','assert_nba_game_imports'),
  ('supabase/functions/_shared/gameIdentity.ts','assert_nba_game_unambiguous'),
  ('supabase/functions/_shared/matchupGeneration.ts','replace_regular_season_matchups_atomic'),
  ('supabase/functions/_shared/notifications.ts','notif_suppress_atomic'),
  ('supabase/functions/_shared/notifications.ts','notif_admit_delivery_atomic'),
  ('supabase/functions/_shared/notifications.ts','record_notification_outbox_ticket_atomic'),
  ('supabase/functions/_shared/notifications.ts','notif_begin_web_atomic'),
  ('supabase/functions/_shared/notifications.ts','notif_finish_web_atomic'),
  ('supabase/functions/_shared/notifications.ts','clear_push_token_for_user_atomic'),
  ('supabase/functions/_shared/playerImports.ts','resolve_player_imports_atomic'),
  ('supabase/functions/_shared/seasonBoundary.ts','draft_timer_start_warning'),
  ('supabase/functions/_shared/seasonBoundary.ts','start_rookie_draft_atomic'),
  ('supabase/functions/_shared/seasonBoundary.ts','process_expired_snake_picks_atomic'),
  ('supabase/functions/_shared/seasonBoundary.ts','auto_pick_snake_pick_atomic'),
  ('supabase/functions/_shared/seasonBoundary.ts','activate_rookie_draft_league_atomic'),
  ('supabase/functions/_shared/seasonBoundary.ts','get_stale_score_weeks'),
  ('supabase/functions/_shared/seasonBoundary.ts','apply_season_boundary_after_grace'),
  ('supabase/functions/_shared/sourceLinks.ts','link_player_sources_atomic'),
  ('supabase/functions/_shared/syncRuns.ts','start_edge_invocation'),
  ('supabase/functions/_shared/syncRuns.ts','finish_edge_invocation'),
  ('supabase/functions/_shared/syncScores.ts','get_stale_score_weeks'),
  ('supabase/functions/_shared/syncScores.ts','get_score_sync_games'),
  ('supabase/functions/_shared/syncScores.ts','capture_score_inputs'),
  ('supabase/functions/_shared/syncScores.ts','finalize_score_week_atomic'),
  ('supabase/functions/_shared/syncScores.ts','update_score_points_atomic'),
  ('supabase/functions/_shared/syncStats.ts','get_score_sync_games'),
  ('supabase/functions/_shared/syncStats.ts','save_live_scoreboard_atomic'),
  ('supabase/functions/_shared/syncStats.ts','save_final_game_snapshot_atomic'),
  ('supabase/functions/_shared/syncStats.ts','save_game_stats_atomic'),
  ('supabase/functions/_shared/syncStats.ts','save_live_game_stats_atomic'),
  ('supabase/functions/_shared/tradeActivation.ts','activate_rookie_draft_league_atomic'),
  ('supabase/functions/api/draft.ts','start_auction_draft_atomic'),
  ('supabase/functions/api/draft.ts','create_mock_draft_room_atomic'),
  ('supabase/functions/api/draft.ts','join_mock_draft_room_atomic'),
  ('supabase/functions/api/draft.ts','leave_mock_draft_room_atomic'),
  ('supabase/functions/api/draft.ts','delete_mock_draft_room_atomic'),
  ('supabase/functions/api/draft.ts','start_mock_draft_room_atomic'),
  ('supabase/functions/api/draft.ts','stop_draft_atomic'),
  ('supabase/functions/api/draft.ts','reset_draft_atomic'),
  ('supabase/functions/api/draft.ts','pause_draft_atomic'),
  ('supabase/functions/api/draft.ts','resume_draft_atomic'),
  ('supabase/functions/api/draft.ts','create_auction_nomination_atomic'),
  ('supabase/functions/api/draft.ts','place_auction_bid_atomic'),
  ('supabase/functions/api/draft.ts','withdraw_auction_nomination_atomic'),
  ('supabase/functions/api/draft.ts','start_rookie_draft_atomic'),
  ('supabase/functions/api/draft.ts','make_snake_pick_atomic'),
  ('supabase/functions/api/draft.ts','commissioner_snake_pick_atomic'),
  ('supabase/functions/api/draft.ts','auto_pick_snake_pick_atomic'),
  ('supabase/functions/api/draft.ts','process_expired_snake_pick_atomic'),
  ('supabase/functions/api/draft.ts','activate_rookie_draft_league_for_user_atomic'),
  ('supabase/functions/api/draft.ts','reseed_rookie_draft_picks_atomic'),
  ('supabase/functions/api/draft.ts','draft_timer_start_warning'),
  ('supabase/functions/api/draft.ts','close_expired_auction_nominations_atomic'),
  ('supabase/functions/api/draft.ts','pause_draft_for_absence_atomic'),
  ('supabase/functions/api/draft.ts','resume_draft_if_absent_atomic'),
  ('supabase/functions/api/league.ts','advance_season_atomic'),
  ('supabase/functions/api/playoffs.ts','generate_playoff_bracket_atomic'),
  ('supabase/functions/api/playoffs.ts','advance_playoff_bracket_atomic'),
  ('supabase/functions/api/profile.ts','register_web_push_atomic'),
  ('supabase/functions/api/profile.ts','clear_web_push_for_user_atomic'),
  ('supabase/functions/api/sync.ts','create_or_resume_stats_sync_job_atomic'),
  ('supabase/functions/api/tradeEstimates.ts','get_trade_estimate_inputs'),
  ('supabase/functions/api/tradeEstimates.ts','save_trade_estimate_quote'),
  ('supabase/functions/api/tradeEstimates.ts','get_trade_revaluation_inputs'),
  ('supabase/functions/api/trades.ts','submit_trade_offer_atomic'),
  ('supabase/functions/api/trades.ts','accept_trade_with_plan_atomic'),
  ('supabase/functions/api/trades.ts','accept_trade_atomic'),
  ('supabase/functions/api/trades.ts','reject_trade_atomic'),
  ('supabase/functions/api/trades.ts','withdraw_trade_atomic'),
  ('supabase/functions/api/trades.ts','veto_trade_atomic'),
  ('supabase/functions/api/trades.ts','add_trade_block_item_atomic'),
  ('supabase/functions/api/trades.ts','remove_trade_block_item_atomic'),
  ('supabase/functions/api/trades.ts','get_trade_roster_preview'),
  ('supabase/functions/api/trades.ts','set_trade_roster_plan_atomic'),
  ('supabase/functions/api/trades.ts','set_trade_taxi_destinations_atomic'),
  ('supabase/functions/api/version/index.ts','get_league_version'),
  ('supabase/functions/api/waivers.ts','create_waiver_claim_atomic'),
  ('supabase/functions/api/waivers.ts','cancel_waiver_claim_atomic'),
  ('supabase/functions/api/waivers.ts','edit_waiver_claim_atomic'),
  ('supabase/functions/api/waivers.ts','reorder_waiver_claim_atomic'),
  ('supabase/functions/close-expired-nominations/close.ts','close_expired_auction_nominations_atomic'),
  ('supabase/functions/close-expired-nominations/close.ts','process_expired_snake_picks_atomic'),
  ('supabase/functions/lineup-optimizer/index.ts','get_league_projection_rows'),
  ('supabase/functions/lineup-optimizer/index.ts','auto_set_lineup_service_atomic'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','claim_lineup_tipoff_dispatch'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','renew_lineup_tipoff_dispatch'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','get_pending_tipoff_members'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','get_pre_tipoff_lineup_context'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','get_league_projection_rows'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','apply_pre_tipoff_lineup'),
  ('supabase/functions/lineup-optimizer/preTipoff.ts','finish_lineup_tipoff_dispatch'),
  ('supabase/functions/live-poll/runner.ts','get_live_poll_work'),
  ('supabase/functions/live-poll/runner.ts','record_live_poll_attempts'),
  ('supabase/functions/live-poll/runner.ts','try_live_poll_lease'),
  ('supabase/functions/live-poll/runner.ts','renew_live_poll_lease'),
  ('supabase/functions/live-poll/runner.ts','release_live_poll_lease'),
  ('supabase/functions/live-poll/scoreboard.ts','save_live_scoreboard_atomic'),
  ('supabase/functions/matchup-forecast/index.ts','claim_matchup_forecasts'),
  ('supabase/functions/matchup-forecast/index.ts','get_matchup_forecast_context'),
  ('supabase/functions/matchup-forecast/index.ts','complete_matchup_forecast'),
  ('supabase/functions/matchup-forecast/index.ts','fail_matchup_forecast'),
  ('supabase/functions/process-trades/index.ts','process_due_accepted_trades_atomic'),
  ('supabase/functions/process-trades/index.ts','claim_notification_outbox_atomic'),
  ('supabase/functions/process-trades/index.ts','complete_notification_outbox_atomic'),
  ('supabase/functions/process-trades/index.ts','fail_notification_outbox_atomic'),
  ('supabase/functions/process-trades/index.ts','dead_letter_notification_outbox_atomic'),
  ('supabase/functions/process-trades/index.ts','expire_pending_trades_atomic'),
  ('supabase/functions/process-trades/index.ts','claim_notification_receipts_atomic'),
  ('supabase/functions/process-trades/index.ts','clear_push_token_for_user_atomic'),
  ('supabase/functions/process-trades/index.ts','defer_notification_receipt_state_atomic'),
  ('supabase/functions/process-waivers/index.ts','process_due_waiver_claims_atomic'),
  ('supabase/functions/process-waivers/index.ts','count_due_waiver_claims'),
  ('supabase/functions/process-waivers/index.ts','expire_waiver_wire_logs'),
  ('supabase/functions/sync-players/career.ts','claim_player_career_base_atomic'),
  ('supabase/functions/sync-players/career.ts','complete_player_career_base_atomic'),
  ('supabase/functions/sync-players/nbaIds.ts','merge_duplicate_players'),
  ('supabase/functions/sync-players/release.ts','resolve_player_imports_atomic'),
  ('supabase/functions/sync-players/release.ts','complete_player_roster_cycle_atomic'),
  ('supabase/functions/sync-schedule/index.ts','publish_nba_schedule_atomic'),
  ('supabase/functions/sync-scores/index.ts','try_live_poll_lease'),
  ('supabase/functions/sync-scores/index.ts','release_live_poll_lease'),
  ('supabase/functions/sync-sleeper-projections/sync.ts','complete_sleeper_projection_sync'),
  ('supabase/functions/sync-stats/index.ts','claim_stats_sync_job_atomic'),
  ('supabase/functions/sync-stats/index.ts','checkpoint_stats_sync_job_atomic'),
  ('supabase/functions/sync-stats/index.ts','release_stats_sync_job_atomic'),
  ('supabase/functions/sync-stats/index.ts','complete_stats_sync_job_atomic'),
  ('supabase/functions/sync-stats/index.ts','fail_stats_sync_job_atomic'),
  ('supabase/functions/sync-stats/index.ts','invoke_edge_function'),
  ('supabase/functions/verify/database.ts','count_final_games_missing_stats');
CREATE TEMP TABLE version_roots AS SELECT * FROM version_functions WHERE schema_name='public'
  AND (proname LIKE '%\_atomic' OR proname IN (SELECT function_name FROM version_worker_rpcs));
CREATE TEMP TABLE version_reachable AS
  WITH RECURSIVE calls(root,oid) AS (
    SELECT proname,oid FROM version_roots
    UNION
    SELECT calls.root,callee.oid FROM calls
      JOIN version_functions caller ON caller.oid=calls.oid
      JOIN version_functions callee ON caller.prosrc ~ ('\m'||callee.proname||'\s*\(')
  ) SELECT DISTINCT calls.root,functions.* FROM calls JOIN version_functions functions USING(oid);
CREATE TEMP TABLE version_mutations AS
  SELECT DISTINCT reachable.root,namespace.nspname AS schema_name,relation.relname,relation.oid
  FROM version_reachable reachable
  CROSS JOIN LATERAL regexp_matches(reachable.prosrc,'(?i)(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:(public|private|analytics)\.)?([a-z_][a-z_0-9]*)','g') mutation
  JOIN pg_namespace namespace ON namespace.nspname=COALESCE(mutation[1],'public')
  JOIN pg_class relation ON relation.relnamespace=namespace.oid AND relation.relname=mutation[2] AND relation.relkind='r';
CREATE TEMP TABLE version_internal_tables(name text PRIMARY KEY);
INSERT INTO version_internal_tables VALUES
  ('notification_outbox'),('sync_jobs'),('sync_runs'),('backfill_game_attempts'),('web_push_subscriptions'),
  ('lineup_tipoff_dispatches'),('lineup_tipoff_members'),('edge_invocations'),('live_poll_leases');
CREATE TEMP TABLE version_worker_targets(path text,table_name text);
INSERT INTO version_worker_targets VALUES
  ('supabase/functions/_shared/backfillJobs.ts','sync_jobs'),
  ('supabase/functions/_shared/backfillJobs.ts','backfill_game_attempts'),
  ('supabase/functions/_shared/cdnBackfill.ts','nba_games'),
  ('supabase/functions/_shared/notificationDraft.ts','notification_outbox'),
  ('supabase/functions/_shared/notifications.ts','web_push_subscriptions'),
  ('supabase/functions/_shared/seasonBoundary.ts','leagues'),
  ('supabase/functions/_shared/syncRuns.ts','sync_runs'),
  ('supabase/functions/lineup-optimizer/index.ts','lineup_optimizer_settings'),
  ('supabase/functions/sync-players/career.ts','players'),
  ('supabase/functions/sync-players/index.ts','dynasty_news'),
  ('supabase/functions/sync-players/injuries.ts','players'),
  ('supabase/functions/sync-players/nbaIds.ts','players'),
  ('supabase/functions/sync-projections/index.ts','projection_sync_runs'),
  ('supabase/functions/sync-projections/index.ts','fantasypros_projection_rows'),
  ('supabase/functions/sync-projections/index.ts','player_projections'),
  ('supabase/functions/sync-sleeper-projections/sync.ts','projection_sync_runs');
CREATE FUNCTION pg_temp.version_coverage_check() RETURNS void LANGUAGE plpgsql AS $$
DECLARE missing text;
BEGIN
  SELECT string_agg(DISTINCT mutation.root||' -> '||mutation.schema_name||'.'||mutation.relname,', ' ORDER BY mutation.root||' -> '||mutation.schema_name||'.'||mutation.relname)
    INTO missing FROM version_mutations mutation
    WHERE mutation.schema_name='public' AND NOT EXISTS(SELECT 1 FROM version_internal_tables WHERE name=mutation.relname)
      AND (SELECT count(*) FROM pg_trigger trigger JOIN pg_proc function ON function.oid=trigger.tgfoid
        WHERE trigger.tgrelid=mutation.oid AND NOT trigger.tgisinternal AND trigger.tgenabled<>'D'
          AND function.proname IN ('league_version_capture','emit_league_inventory_change'))<>3;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Uncovered screen writes: %',missing; END IF;
  SELECT string_agg(worker.path||' -> '||worker.table_name,', ') INTO missing
    FROM version_worker_targets worker
    WHERE NOT EXISTS(SELECT 1 FROM version_internal_tables WHERE name=worker.table_name)
      AND (SELECT count(*) FROM pg_trigger trigger JOIN pg_proc function ON function.oid=trigger.tgfoid
        WHERE trigger.tgrelid=to_regclass('public.'||worker.table_name) AND NOT trigger.tgisinternal AND trigger.tgenabled<>'D'
          AND function.proname IN ('league_version_capture','emit_league_inventory_change'))<>3;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Uncovered worker writes: %',missing; END IF;
END;
$$;
SELECT pg_temp.version_coverage_check();
DO $$
DECLARE caught boolean:=false;
BEGIN
  ALTER TABLE public.roster_players DISABLE TRIGGER league_version_insert;
  BEGIN
    PERFORM pg_temp.version_coverage_check();
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Uncovered screen writes:%roster_players%' THEN RAISE; END IF;
    caught:=true;
  END;
  ALTER TABLE public.roster_players ENABLE TRIGGER league_version_insert;
  IF NOT caught THEN RAISE EXCEPTION 'Coverage accepts a missing trigger'; END IF;
END;
$$;
CREATE TEMP TABLE version_rollback_proofs(path text PRIMARY KEY,result text);
DO $$
DECLARE root record; args text; result text;
BEGIN
  FOR root IN SELECT * FROM version_roots ORDER BY proname LOOP
    SELECT string_agg('NULL::'||format_type(type,NULL),',' ORDER BY position) INTO args
      FROM unnest((SELECT proargtypes FROM pg_proc WHERE oid=root.oid)) WITH ORDINALITY argument(type,position);
    BEGIN
      EXECUTE format('SELECT public.%I(%s)',root.proname,COALESCE(args,''));
      RAISE EXCEPTION 'version forced rollback' USING ERRCODE='V0001';
    EXCEPTION WHEN OTHERS THEN result:=SQLSTATE; END;
    IF EXISTS(SELECT 1 FROM private.league_version_pending) THEN RAISE EXCEPTION 'Rollback leaves a pending version: %',root.proname; END IF;
    INSERT INTO version_rollback_proofs VALUES(root.oid::regprocedure::text,result);
  END LOOP;
END;
$$;
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
SELECT root.oid::regprocedure::text AS write_path,
  COALESCE(string_agg(DISTINCT mutation.schema_name||'.'||mutation.relname,', ' ORDER BY mutation.schema_name||'.'||mutation.relname),'no table mutation') AS writes,
  proof.result AS rollback_sqlstate
  FROM version_roots root JOIN version_rollback_proofs proof ON proof.path=root.oid::regprocedure::text
  LEFT JOIN version_mutations mutation ON mutation.root=root.proname
  GROUP BY root.oid,root.proname,proof.result ORDER BY root.proname,root.oid;
SELECT path,table_name AS writes FROM version_worker_targets ORDER BY path,table_name;
SELECT path,function_name AS rpc FROM version_worker_rpcs ORDER BY path,function_name;
SELECT count(*) AS atomic_paths_checked FROM version_roots WHERE proname LIKE '%\_atomic';
SELECT count(*) AS rpc_paths_checked FROM version_rollback_proofs;
ROLLBACK;
