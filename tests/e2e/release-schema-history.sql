-- Read only metadata. Never return stored migration SQL, function bodies, or application rows.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';

SELECT jsonb_build_object(
  'history', (
    SELECT jsonb_agg(jsonb_build_object(
      'version', m.version,
      'name', m.name,
      'statementCount', cardinality(m.statements),
      -- SHA-256 of ordered, concatenated per-statement SHA-256 hex strings.
      -- A null entry contributes a distinct marker; an absent/empty array yields null.
      'statementsSha256', (
        SELECT encode(sha256(convert_to(string_agg(
          coalesce(encode(sha256(convert_to(s.statement, 'UTF8')), 'hex'), 'null'),
          '' ORDER BY s.ordinality
        ), 'UTF8')), 'hex')
        FROM unnest(m.statements) WITH ORDINALITY AS s(statement, ordinality)
      )
    ) ORDER BY m.version)
    FROM supabase_migrations.schema_migrations m
  ),
  'functions', (
    SELECT jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'identityArguments', pg_get_function_identity_arguments(p.oid),
      'bodySha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
      'securityDefiner', p.prosecdef,
      'config', p.proconfig,
      'language', l.lanname,
      'publicExecute', EXISTS (
        SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
      ),
      'anonExecute', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticatedExecute', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'serviceRoleExecute', has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) ORDER BY p.proname, p.oid)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND p.proname IN (
      'assert_current_league_season_for_lineup',
      'auto_set_lineup_atomic', 'auto_set_lineup_atomic_unchecked',
      'set_player_slot_moves_atomic', 'set_player_slot_moves_atomic_unchecked',
      'update_lineup_slots_atomic', 'update_lineup_slots_atomic_unchecked'
    )
  ),
  'oldHelperCount', (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'auto_set_lineup_atomic_unchecked_cycle18', 'auto_set_lineup_atomic_unchecked_legacy',
      'set_player_slot_moves_atomic_unchecked_cycle18', 'set_player_slot_moves_atomic_unchecked_legacy',
      'update_lineup_slots_atomic_uncapped_cycle23', 'update_lineup_slots_atomic_unchecked_legacy'
    )
  ),
  'oldHelperReferenceCount', (
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosrc ~ '(unchecked_cycle18|uncapped_cycle23|unchecked_legacy)'
  )
) AS snapshot;

ROLLBACK;
