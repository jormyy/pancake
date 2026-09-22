-- Metadata only: no application rows, function bodies, credentials, or mutations.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT jsonb_build_object(
  'replicationRole', current_setting('session_replication_role'),
  'functions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'schema', n.nspname, 'name', p.proname,
    'identityArguments', pg_get_function_identity_arguments(p.oid),
    'arguments', pg_get_function_arguments(p.oid), 'result', pg_get_function_result(p.oid),
    'bodySha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
    'language', l.lanname, 'securityDefiner', p.prosecdef, 'config', p.proconfig,
    'volatility', p.provolatile, 'strict', p.proisstrict, 'owner', pg_get_userbyid(p.proowner),
    'publicExecute', EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'),
    'anonExecute', has_function_privilege('anon', p.oid, 'EXECUTE'),
    'authenticatedExecute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
    'serviceRoleExecute', has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE (n.nspname = 'public' AND p.proname IN (
    'drop_player_atomic', 'handle_new_auth_user', 'activate_rookie_draft_league_atomic',
    'invoke_edge_function', 'invoke_edge_function_at_et_time', 'invoke_dynasty_ranking_views_at_et_time',
    'invoke_season_boundary_if_due', 'invoke_live_poll_if_due', 'renew_live_poll_lease', 'edit_waiver_claim_atomic'
  )) OR (n.nspname = 'private' AND p.proname IN (
    'sync_roster_linked_state', 'clear_future_unlocked_lineups', 'lineup_game_started',
    'claim_cron_dispatch', 'reconcile_edge_invocations'
  ))),
  'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', t.tgname, 'enabled', t.tgenabled, 'definition', pg_get_triggerdef(t.oid),
    'functionSchema', n.nspname, 'functionName', p.proname
  ) ORDER BY t.tgname), '[]'::jsonb)
  FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE t.tgrelid = 'public.roster_players'::regclass AND NOT t.tgisinternal),
  'policies', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', policyname, 'permissive', permissive, 'roles', roles, 'command', cmd,
    'using', qual, 'check', with_check
  ) ORDER BY policyname), '[]'::jsonb) FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'waiver_wire_log'),
  'tables', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
    'policies', (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid),
    'anonSelect', has_table_privilege('anon', c.oid, 'SELECT'),
    'authenticatedSelect', has_table_privilege('authenticated', c.oid, 'SELECT'),
    'serviceRoleSelect', has_table_privilege('service_role', c.oid, 'SELECT')
  ) ORDER BY c.relname), '[]'::jsonb) FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    AND c.relname IN ('waiver_wire_log', 'cron_dispatch_state', 'edge_invocations')),
  'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'valid', i.indisvalid, 'ready', i.indisready, 'definition', pg_get_indexdef(c.oid)
  ) ORDER BY c.relname), '[]'::jsonb) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (
    'profiles_push_token_lookup', 'idx_sync_runs_started_at', 'idx_projection_sync_runs_started_at',
    'idx_standings_season_member_week', 'idx_edge_invocations_unreconciled', 'idx_edge_invocations_reconciled_at'
  )),
  'serviceRoleMissingReads', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND NOT has_table_privilege('service_role', c.oid, 'SELECT'))
) AS snapshot;
ROLLBACK;
