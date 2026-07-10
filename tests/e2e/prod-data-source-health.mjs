import path from 'node:path'
import process from 'node:process'
import { cleanMessage, envValue, isProductionSupabaseUrl, querySupabaseDb, requireEnv, writeMarkdownReport } from './env.mjs'
import { evaluateCrudReadiness, evaluateProductionDataHealth } from './prod-data-health-contract.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/prod-data-source-health-report.md')

const CORE_TABLES = [
  'backfill_game_attempts',
  'bids',
  'draft_budgets',
  'draft_orders',
  'draft_picks',
  'drafts',
  'league_members',
  'league_seasons',
  'leagues',
  'lineup_slot_templates',
  'live_poll_leases',
  'matchups',
  'nba_games',
  'nominations',
  'player_game_stats',
  'player_projections',
  'players',
  'profiles',
  'roster_players',
  'roster_transactions',
  'rps_challenges',
  'season_weeks',
  'snake_draft_picks',
  'standings',
  'sync_jobs',
  'trade_items',
  'trade_vetos',
  'trades',
  'waiver_claims',
  'waiver_priorities',
  'waiver_wire_log',
  'weekly_lineups',
]

const CORE_RPCS = [
  'accept_trade_atomic',
  'add_free_agent_atomic',
  'advance_season_atomic',
  'auto_set_lineup_atomic',
  'cancel_waiver_claim_atomic',
  'clear_ineligible_taxi_players',
  'close_auction_nomination_atomic',
  'complete_accepted_trade_atomic',
  'compute_fantasy_points',
  'count_final_games_missing_stats',
  'create_auction_nomination_atomic',
  'create_league',
  'create_waiver_claim_atomic',
  'current_season_year_et',
  'drop_player_atomic',
  'expire_trade_completion_failure_atomic',
  'expire_waiver_wire_logs',
  'invoke_edge_function',
  'invoke_edge_function_at_et_time',
  'join_league_by_invite_code',
  'make_snake_pick_atomic',
  'merge_players',
  'place_auction_bid_atomic',
  'process_due_waiver_claims_atomic',
  'process_next_waiver_claim_atomic',
  'release_live_poll_lease',
  'reseed_rookie_draft_picks_atomic',
  'reset_draft_atomic',
  'start_auction_draft_atomic',
  'start_rookie_draft_atomic',
  'stop_draft_atomic',
  'toggle_ir_atomic',
  'toggle_taxi_atomic',
  'try_live_poll_lease',
  'veto_trade_atomic',
  'withdraw_auction_nomination_atomic',
]

const args = new Set(process.argv.slice(2))
const dbTarget = args.has('--linked') ? 'linked' : 'local'
const allowWrites = args.has('--allow-prod-writes') || process.env.E2E_ALLOW_PROD_WRITES === '1'
if (args.has('--allow-prod-writes')) process.env.E2E_ALLOW_PROD_WRITES = '1'

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`

const queryDb = (label, sql, timeout = 45000) => querySupabaseDb(dbTarget, label, sql, timeout)

const tableCountSql = CORE_TABLES
  .map((table) => `SELECT ${sqlLiteral(table)} AS table_name, count(*)::bigint AS row_count FROM public.${table}`)
  .join('\nUNION ALL\n')

const rpcCatalogSql = `
WITH expected(proname) AS (
  VALUES ${CORE_RPCS.map((name) => `(${sqlLiteral(name)})`).join(', ')}
)
SELECT e.proname, count(p.oid)::int AS overloads
  FROM expected e
  LEFT JOIN pg_namespace n
    ON n.nspname = 'public'
  LEFT JOIN pg_proc p
    ON p.proname = e.proname
   AND p.pronamespace = n.oid
 GROUP BY e.proname
 ORDER BY e.proname;
`

const sourceHealthSql = `
WITH season AS (
  SELECT public.current_season_year_et(now()) AS season_year
),
final_games AS (
  SELECT g.id, g.nba_game_id, g.game_date
    FROM public.nba_games g, season s
   WHERE g.season_year = s.season_year
     AND g.status = 'Final'
     AND g.nba_game_id IS NOT NULL
),
stat_game_ids AS (
  SELECT DISTINCT s.game_id
    FROM public.player_game_stats s, season y
   WHERE s.season_year = y.season_year
),
final_missing AS (
  SELECT f.id
    FROM final_games f
    LEFT JOIN stat_game_ids s ON s.game_id = f.id
   WHERE s.game_id IS NULL
)
SELECT
  (SELECT season_year FROM season) AS season_year,
  (SELECT count(*) FROM public.nba_games g, season s WHERE g.season_year = s.season_year) AS nba_games,
  (SELECT count(*) FROM final_games) AS final_games,
  (SELECT count(*) FROM final_missing) AS final_games_without_stats,
  public.count_final_games_missing_stats((SELECT season_year FROM season)) AS final_missing_stats_rpc,
  (SELECT count(*) FROM public.nba_games g, season s WHERE g.season_year = s.season_year AND g.nba_game_id IS NULL) AS games_missing_nba_game_id,
  (SELECT count(*) FROM public.players WHERE nba_id IS NULL) AS players_without_nba_id,
  (SELECT count(*) FROM public.players WHERE sleeper_id IS NULL) AS players_without_sleeper_id,
  (SELECT count(*) FROM public.players) AS players,
  (SELECT count(*) FROM public.player_projections) AS projections,
  (SELECT max(fetched_at) FROM public.player_projections) AS latest_projection_fetch,
  (SELECT count(*) FROM public.sync_jobs WHERE status NOT IN ('completed', 'failed')) AS open_sync_jobs;
`

const crudSmokeSql = `
CREATE TEMP TABLE prod_data_health_counts (
  inserted int,
  updated int,
  deleted int,
  residue int
) ON COMMIT DROP;

DO $$
DECLARE
  v_inserted int := 0;
  v_updated int := 0;
  v_deleted int := 0;
  v_residue int := 0;
BEGIN
  DELETE FROM public.live_poll_leases
   WHERE lock_key = -72026062700015;

  INSERT INTO public.live_poll_leases (lock_key, holder_id, expires_at)
  VALUES (-72026062700015, gen_random_uuid(), now() + interval '1 minute');
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.live_poll_leases
     SET expires_at = now() + interval '2 minutes'
   WHERE lock_key = -72026062700015;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  DELETE FROM public.live_poll_leases
   WHERE lock_key = -72026062700015;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT count(*) INTO v_residue
    FROM public.live_poll_leases
   WHERE lock_key = -72026062700015;

  INSERT INTO prod_data_health_counts
  VALUES (v_inserted, v_updated, v_deleted, v_residue);
END $$;

SELECT * FROM prod_data_health_counts;
`

const fetchJson = async (label, url, timeoutMs = 30000) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 PancakeLaunchHealth/1.0',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://www.nba.com',
        Referer: 'https://www.nba.com/',
      },
    })
    const text = await res.text()
    const ms = Date.now() - started
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
    return { data: JSON.parse(text), responseTimeMs: ms, status: res.status }
  } finally {
    clearTimeout(timeout)
  }
}

const checkNba = async () => {
  const base = envValue('NBA_CDN_BASE_URL') ?? 'https://cdn.nba.com/static/json'
  const scoreboard = await fetchJson('NBA scoreboard', `${base}/liveData/scoreboard/todaysScoreboard_00.json`, 20000)
  const schedule = await fetchJson('NBA schedule', `${base}/staticData/scheduleLeagueV2_1.json`, 30000)
  const games = schedule.data?.leagueSchedule?.gameDates?.flatMap((day) => day.games ?? []) ?? []
  const regularSeasonGames = games.filter((game) => String(game.gameId ?? '').startsWith('002'))
  return {
    scoreboardStatus: scoreboard.status,
    scoreboardMs: scoreboard.responseTimeMs,
    todayGames: scoreboard.data?.scoreboard?.games?.length ?? 0,
    scheduleStatus: schedule.status,
    scheduleMs: schedule.responseTimeMs,
    scheduleSeasonYear: schedule.data?.leagueSchedule?.seasonYear ?? null,
    scheduledGames: games.length,
    regularSeasonGames: regularSeasonGames.length,
    firstRegularSeasonDate: regularSeasonGames[0]?.gameDateEst?.slice(0, 10) ?? null,
    lastRegularSeasonDate: regularSeasonGames.at(-1)?.gameDateEst?.slice(0, 10) ?? null,
  }
}

const checkSleeper = async () => {
  const base = envValue('SLEEPER_BASE_URL') ?? 'https://api.sleeper.app/v1'
  const result = await fetchJson('Sleeper players', `${base}/players/nba`, 30000)
  const rows = Object.values(result.data ?? {})
  const nbaPlayers = rows.filter((player) => player?.sport === 'nba')
  const numericIds = nbaPlayers.filter((player) => /^\d+$/.test(String(player?.player_id ?? '')))
  const active = nbaPlayers.filter((player) => player?.active === true)
  return {
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    totalRows: rows.length,
    nbaPlayers: nbaPlayers.length,
    numericPlayerIds: numericIds.length,
    activePlayers: active.length,
  }
}

const rows = []
const addRow = (requirement, status, evidence) => rows.push({ requirement, status, evidence })

try {
  if (dbTarget === 'linked' && allowWrites) {
    const supabaseUrl = envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL')
    if (!supabaseUrl) {
      throw new Error('Linked write smoke requires E2E_SUPABASE_URL, SUPABASE_URL, or EXPO_PUBLIC_SUPABASE_URL for the production safety guard.')
    }
    if (isProductionSupabaseUrl(supabaseUrl)) {
      requireEnv({ supabaseUrl, serviceRoleKey: 'explicit-write-opt-in' }, ['supabaseUrl', 'serviceRoleKey'])
    }
  }

  const tableRows = queryDb('core table counts', tableCountSql)
  const missingTables = CORE_TABLES.filter((table) => !tableRows.some((row) => row.table_name === table))
  addRow(
    'Core table query sweep',
    missingTables.length === 0 ? 'PASS' : 'BLOCKED',
    missingTables.length === 0
      ? `${tableRows.length} core tables queried; non-empty tables: ${tableRows.filter((row) => Number(row.row_count) > 0).length}.`
      : `Missing or unqueryable tables: ${missingTables.join(', ')}.`,
  )

  const rpcRows = queryDb('core RPC catalog', rpcCatalogSql)
  const missingRpcs = rpcRows.filter((row) => Number(row.overloads) === 0).map((row) => row.proname)
  addRow(
    'Core RPC catalog sweep',
    missingRpcs.length === 0 ? 'PASS' : 'BLOCKED',
    missingRpcs.length === 0
      ? `${rpcRows.length} RPC names found in public schema.`
      : `Missing RPCs: ${missingRpcs.join(', ')}.`,
  )

  const [sourceHealth] = queryDb('source health aggregates', sourceHealthSql)
  const dataReadiness = evaluateProductionDataHealth(sourceHealth)
  addRow(
    'DB source-health aggregates',
    dataReadiness.failures.length === 0 ? 'PASS' : 'BLOCKED',
    `season=${sourceHealth?.season_year}, games=${sourceHealth?.nba_games}, final=${sourceHealth?.final_games}, final_missing_stats=${sourceHealth?.final_games_without_stats}, missing_nba_id_games=${sourceHealth?.games_missing_nba_game_id}, players=${sourceHealth?.players}, players_without_nba_id=${sourceHealth?.players_without_nba_id}, players_without_sleeper_id=${sourceHealth?.players_without_sleeper_id}, projections=${sourceHealth?.projections}, latest_projection_fetch=${sourceHealth?.latest_projection_fetch}, open_sync_jobs=${sourceHealth?.open_sync_jobs}; ${dataReadiness.failures.join('; ') || 'thresholds passed'}.`,
  )

  if (allowWrites) {
    const [crud] = queryDb('CRUD smoke', crudSmokeSql)
    const crudReadiness = evaluateCrudReadiness(true, crud)
    addRow(
      'Opt-in CRUD smoke',
      crudReadiness.pass ? 'PASS' : 'BLOCKED',
      `${dbTarget} live_poll_leases ${crudReadiness.evidence}.`,
    )
  } else {
    const crudReadiness = evaluateCrudReadiness(false, null)
    addRow(
      'Opt-in CRUD smoke',
      'BLOCKED',
      `${crudReadiness.evidence} Pass --allow-prod-writes or set E2E_ALLOW_PROD_WRITES=1 for intentional cleanup-backed writes against ${dbTarget}.`,
    )
  }

  const nba = await checkNba()
  addRow(
    'NBA CDN source shape',
    nba.scheduleStatus === 200 && nba.scoreboardStatus === 200 && nba.regularSeasonGames > 0 ? 'PASS' : 'BLOCKED',
    `scoreboard ${nba.scoreboardStatus} in ${nba.scoreboardMs}ms (${nba.todayGames} games today); schedule ${nba.scheduleStatus} in ${nba.scheduleMs}ms, season=${nba.scheduleSeasonYear}, regularSeasonGames=${nba.regularSeasonGames}, first=${nba.firstRegularSeasonDate}, last=${nba.lastRegularSeasonDate}.`,
  )

  const sleeper = await checkSleeper()
  addRow(
    'Sleeper NBA player source shape',
    sleeper.status === 200 && sleeper.nbaPlayers > 100 && sleeper.numericPlayerIds > 100 ? 'PASS' : 'BLOCKED',
    `status=${sleeper.status} in ${sleeper.responseTimeMs}ms; totalRows=${sleeper.totalRows}, nbaPlayers=${sleeper.nbaPlayers}, numericPlayerIds=${sleeper.numericPlayerIds}, activePlayers=${sleeper.activePlayers}.`,
  )
} catch (error) {
  addRow('Prod data-source health runner', 'BLOCKED', cleanMessage(error instanceof Error ? error.message : String(error)))
}

const blockers = rows.filter((row) => row.status !== 'PASS')
await writeMarkdownReport({
  reportPath: REPORT_PATH,
  title: 'Production Data-Source Health',
  rows,
  columns: [
    { header: 'Requirement', value: (row) => row.requirement },
    { header: 'Status', value: (row) => row.status },
    { header: 'Evidence', value: (row) => row.evidence },
  ],
})
console.log(`${blockers.length === 0 ? 'PASS' : 'BLOCKED'} ${REPORT_PATH}`)
if (blockers.length > 0) process.exitCode = 1
