BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '500ms';
SELECT jsonb_build_object(
  'capturedAt',clock_timestamp(),
  'database',current_database(),
  'serverStartedAt',pg_postmaster_start_time(),
  'serverVersion',current_setting('server_version'),
  'databaseBytes',pg_database_size(current_database()),
  'missingFinalStats',(SELECT jsonb_build_object('games',count(*),'oldestDate',min(game.game_date))
    FROM public.nba_games game WHERE game.status='Final'
      AND NOT EXISTS(SELECT 1 FROM public.player_game_stats stats WHERE stats.game_id=game.id)),
  'settings',(SELECT jsonb_object_agg(name,setting) FROM pg_settings WHERE name IN
    ('pg_stat_statements.track','shared_buffers','effective_cache_size','work_mem','maintenance_work_mem',
     'max_connections','block_size','statement_timeout','lock_timeout','idle_in_transaction_session_timeout',
     'autovacuum','autovacuum_vacuum_scale_factor','autovacuum_analyze_scale_factor')),
  'statementStatsResetAt',(SELECT stats_reset FROM extensions.pg_stat_statements_info),
  'statementStatsDeallocations',(SELECT dealloc FROM extensions.pg_stat_statements_info),
  'statisticsResetAt',(SELECT stats_reset FROM pg_stat_database WHERE datname=current_database()),
  'wal',(SELECT jsonb_build_object('bytes',wal_bytes,'records',wal_records,'fullPageImages',wal_fpi,'statsResetAt',stats_reset) FROM pg_stat_wal),
  'tables',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'relation',s.schemaname||'.'||s.relname,'estimatedLiveRows',s.n_live_tup,'estimatedDeadRows',s.n_dead_tup,
    'partitionRoot',coalesce((SELECT root_namespace.nspname||'.'||root.relname
      FROM pg_class root JOIN pg_namespace root_namespace ON root_namespace.oid=root.relnamespace
      WHERE root.oid=pg_partition_root(s.relid)),s.schemaname||'.'||s.relname),
    'totalBytes',pg_total_relation_size(s.relid),'heapBytes',pg_table_size(s.relid),'indexBytes',pg_indexes_size(s.relid),
    'inserted',s.n_tup_ins,'updated',s.n_tup_upd,'hotUpdated',s.n_tup_hot_upd,'deleted',s.n_tup_del,
    'sequentialScans',s.seq_scan,'indexScans',s.idx_scan,'lastAutovacuum',s.last_autovacuum,
    'lastAnalyze',s.last_analyze,'lastAutoanalyze',s.last_autoanalyze,'modifiedSinceAnalyze',s.n_mod_since_analyze,'options',c.reloptions,
    'partitioned',c.relkind='p','partition',c.relispartition) ORDER BY pg_total_relation_size(s.relid) DESC),'[]'::jsonb)
    FROM pg_stat_all_tables s JOIN pg_class c ON c.oid=s.relid
    WHERE s.schemaname IN ('public','private','analytics','cron','net')),
  'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'relation',s.schemaname||'.'||s.relname,'name',s.indexrelname,'bytes',pg_relation_size(s.indexrelid),
    'scans',s.idx_scan,'tuplesRead',s.idx_tup_read,'tuplesFetched',s.idx_tup_fetch,
    'primary',i.indisprimary,'unique',i.indisunique,'valid',i.indisvalid,
    'definition',pg_get_indexdef(s.indexrelid)) ORDER BY pg_relation_size(s.indexrelid) DESC),'[]'::jsonb)
    FROM pg_stat_all_indexes s JOIN pg_index i ON i.indexrelid=s.indexrelid
    WHERE s.schemaname IN ('public','private','analytics','cron','net')),
  'statements',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'queryId',s.queryid::text,'userId',s.userid::text,'query',s.query,'topLevel',s.toplevel,'calls',s.calls,'rows',s.rows,
    'totalMilliseconds',s.total_exec_time,'meanMilliseconds',s.mean_exec_time,
    'sharedHits',s.shared_blks_hit,'sharedReads',s.shared_blks_read,'sharedDirtied',s.shared_blks_dirtied,
    'sharedWritten',s.shared_blks_written,'tempReads',s.temp_blks_read,'tempWritten',s.temp_blks_written,
    'walBytes',s.wal_bytes) ORDER BY s.total_exec_time DESC),'[]'::jsonb)
    FROM extensions.pg_stat_statements s WHERE s.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())),
  'waitingSessions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'),
  'idleTransactions',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'),
  'oldestTransactionSeconds',(SELECT COALESCE(max(extract(epoch FROM timeofday()::timestamptz-xact_start)),0)
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()),
  'roleSettings',(SELECT COALESCE(jsonb_agg(jsonb_build_object('role',r.rolname,'settings',s.setconfig)),'[]'::jsonb)
    FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole
    WHERE r.rolname IN ('authenticator','authenticated','anon','service_role')
      AND s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))),
  'functionSettings',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'function',p.oid::regprocedure::text,'settings',p.proconfig) ORDER BY p.oid::regprocedure::text),'[]'::jsonb)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f')
);
COMMIT;
