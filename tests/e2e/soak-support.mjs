import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import v8 from 'node:v8'
import vm from 'node:vm'
import { createClient } from '@supabase/supabase-js'
import { createFakeUpstreamServer } from './fake-upstream.mjs'
import { resolvedEnv, describeEndpoint } from './env.mjs'
import { parseArgs } from './harness/args.mjs'
import { runBrowserScenarios } from './harness/browser-scenarios.mjs'
import { backendScenarioFailures, runBackendScenarios } from './harness/backend-scenarios.mjs'
import { writeCoverageReport, writeReport } from './harness/reporting.mjs'
import { backendJson, withSupabaseRetry } from './soak-network.mjs'
import {
  EXPECTED_DEFAULT_LINEUP_SLOTS,
  createDisposableLeagueFromSeedUsers,
  currentSeasonYear,
  ensureSleeperFixturePlayer,
  ensureSyntheticSeasonWeeks,
  readLeagueSettingsForClient,
  readLineupSlotsForClient,
  readPlayerBySleeperId,
  signInSupabaseClient,
} from './soak-fixtures.mjs'

export {
  mkdir,
  writeFile,
  path,
  createClient,
  createFakeUpstreamServer,
  resolvedEnv,
  describeEndpoint,
  parseArgs,
  runBrowserScenarios,
  backendScenarioFailures,
  runBackendScenarios,
  writeCoverageReport,
  writeReport,
  EXPECTED_DEFAULT_LINEUP_SLOTS,
  createDisposableLeagueFromSeedUsers,
  currentSeasonYear,
  ensureSleeperFixturePlayer,
  ensureSyntheticSeasonWeeks,
  readLeagueSettingsForClient,
  readLineupSlotsForClient,
  readPlayerBySleeperId,
  signInSupabaseClient,
}

export const execFileAsync = promisify(execFile)
export const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const SNAPSHOT_ROOT = path.join(ROOT, 'tests/snapshots')
export const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
export const PERF_METRICS_PATH = path.join(ARTIFACT_ROOT, 'perf-metrics.json')
export const PERF_DRIFT_LIMIT = Number(process.env.E2E_PERF_DRIFT_LIMIT ?? 1.2)
export const MEMORY_DRIFT_LIMIT = Number(process.env.E2E_MEMORY_DRIFT_LIMIT ?? 1.2)
export const MEMORY_DRIFT_MIN_BYTES = Number(process.env.E2E_MEMORY_DRIFT_MIN_BYTES ?? 48 * 1024 * 1024)
export const MEMORY_HEAP_DRIFT_MIN_BYTES = Number(process.env.E2E_MEMORY_HEAP_DRIFT_MIN_BYTES ?? 24 * 1024 * 1024)
export const REALTIME_CLIENTS = Number(process.env.E2E_REALTIME_CLIENTS ?? 10)
export const REALTIME_LATENCY_LIMIT_MS = Number(process.env.E2E_REALTIME_LATENCY_LIMIT_MS ?? 2000)
export const REALTIME_SUBSCRIBE_TIMEOUT_MS = Number(process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ?? 30000)
export const REALTIME_SETTLE_MS = Number(process.env.E2E_REALTIME_SETTLE_MS ?? 1500)
export const REALTIME_WARMUP_ATTEMPTS = Number(process.env.E2E_REALTIME_WARMUP_ATTEMPTS ?? 5)
export const MIDLIFE_MIGRATION_AFTER_SEASON = Number(process.env.E2E_MIDLIFE_MIGRATION_AFTER_SEASON ?? 5)

const SNAPSHOT_TABLES = [
  'roster_players',
  'draft_picks',
  'standings',
  'league_seasons',
  'waiver_priorities',
]

export const shouldRunScenario = (args, season) => season === 1 || args.repeatScenariosEverySeason

export const timestamp = () => new Date().toISOString()
export const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000

export const roundedMs = (value) => Math.round(value)
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bytesToMiB = (value) => Math.round((value / 1024 / 1024) * 10) / 10
const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).toSorted((left, right) => left - right)
  if (sorted.length === 0) return null
  const midpoint = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint]
}

const runGarbageCollector = () => {
  if (typeof globalThis.gc !== 'function') {
    try {
      v8.setFlagsFromString('--expose_gc')
      globalThis.gc = vm.runInNewContext('gc')
    } catch {
      // GC is unavailable in some Node builds; memory drift will still be measured.
    }
  }
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
    globalThis.gc()
  }
}

export const currentMemory = () => {
  runGarbageCollector()
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage()
  return {
    rssBytes: rss,
    heapUsedBytes: heapUsed,
    externalBytes: external,
    arrayBuffersBytes: arrayBuffers,
  }
}

export const readState = async () => {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export const errorMessage = (error) => error instanceof Error ? error.message : String(error)

export const assertEnv = async (seasons) => {
  const env = resolvedEnv()
  const missing = []
  if (!env.supabaseUrl) missing.push('E2E_SUPABASE_URL or SUPABASE_URL')
  if (!env.serviceRoleKey) {
    missing.push('E2E_PANCAKE_SUPABASE_SECRET_KEY, PANCAKE_SUPABASE_SECRET_KEY, E2E_SUPABASE_SECRET_KEY, or SUPABASE_SECRET_KEY')
  }
  if (missing.length === 0) {
    if (!env.supabaseUrl || !env.serviceRoleKey) throw new Error('Required soak environment disappeared during validation')
    return {
      ...env,
      supabaseUrl: env.supabaseUrl,
      serviceRoleKey: env.serviceRoleKey,
    }
  }

  const now = timestamp()
  await writeReport({
    status: 'BLOCKED',
    startedAt: now,
    finishedAt: now,
    seasons,
    rows: [{ season: 0, status: 'BLOCKED', notes: `Missing env: ${missing.join(', ')}` }],
    notes: [
      'The soak runner loads .env and .env, then fails closed until Supabase admin credentials are available.',
      'Set NBA_CDN_BASE_URL and SLEEPER_BASE_URL to the fake upstream URL when launching backend and Edge functions.',
    ],
  })
  throw new Error(`Missing required soak environment: ${missing.join(', ')}`)
}

const isMissingSchemaError = (error) => {
  const message = error?.message ?? ''
  return (
    error?.code === 'PGRST202' ||
    error?.code === 'PGRST204' ||
    message.includes('Could not find the function') ||
    message.includes('Could not find the') ||
    message.includes('column') && message.includes('does not exist')
  )
}

const requireRpc = async (supabase, name, args, okErrorPattern) => {
  const { error } = await supabase.rpc(name, args)
  if (!error || okErrorPattern?.test(error.message ?? '')) return null
  if (isMissingSchemaError(error)) return `${name}: ${error.message}`
  return null
}

const requireColumn = async (supabase, table, column) => {
  const { error } = await supabase
    .from(table)
    .select(column)
    .limit(1)
  if (!error) return null
  if (isMissingSchemaError(error)) return `${table}.${column}: ${error.message}`
  return null
}

export const runSchemaPreflight = async (supabase) => {
  const zeroUuid = '00000000-0000-0000-0000-000000000000'
  const checks = await Promise.all([
    requireRpc(supabase, 'release_live_poll_lock', {}, null),
    requireRpc(supabase, 'accept_trade_atomic', { p_trade_id: zeroUuid, p_accepting_member_id: zeroUuid }, /Trade not found/i),
    requireRpc(supabase, 'advance_season_atomic', { p_league_id: zeroUuid }, /League not found/i),
    requireRpc(
      supabase,
      'place_auction_bid_atomic',
      { p_draft_id: zeroUuid, p_member_id: zeroUuid, p_nomination_id: zeroUuid, p_amount: 0, p_user_id: zeroUuid },
      /positive integer/i,
    ),
    requireRpc(supabase, 'process_due_waiver_claims_atomic', { p_process_date: '1900-01-01', p_limit: 1 }, null),
    requireRpc(supabase, 'process_next_waiver_claim_atomic', { p_process_date: '1900-01-01' }, null),
    requireColumn(supabase, 'snake_draft_picks', 'draft_pick_id'),
  ])
  return checks.filter(Boolean)
}

export const fetchAll = async (supabase, table, select = '*', filters = {}) => {
  const pageSize = 1000
  const rows = []
  let from = 0

  while (true) {
    let query = supabase
      .from(table)
      .select(select)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    const { data, error } = await query
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break
    from += pageSize
  }

  return rows
}

export const fetchAllIn = async (supabase, table, select, column, values) => {
  if (values.length === 0) return []

  const valueChunks = []
  const uniqueValues = [...new Set(values)]
  for (let index = 0; index < uniqueValues.length; index += 100) {
    valueChunks.push(uniqueValues.slice(index, index + 100))
  }

  const pageSize = 1000
  const rows = []

  for (const chunk of valueChunks) {
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select(select)
        .in(column, chunk)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw new Error(`${table}: ${error.message}`)
      if (!data || data.length === 0) break
      rows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }

  return rows
}

export const E2E_PLAYER_PREFIX = 'e2e-player-'

export const seededPlayerQuery = (supabase, select = 'id, display_name') => supabase
  .from('players')
  .select(select)
  .like('sportsdata_id', `${E2E_PLAYER_PREFIX}%`)
  .not('display_name', 'is', null)
  .order('display_name', { ascending: true })

export const createFallbackE2EPlayers = async (supabase, leagueSeasonId, count, label) => {
  const rows = Array.from({ length: count }, (_, index) => {
    const suffix = `${leagueSeasonId.slice(0, 8)}-${index + 1}`
    const sportsdataId = `${E2E_PLAYER_PREFIX}fallback-${suffix}`
    return {
      sportsdata_id: sportsdataId,
      nba_id: sportsdataId,
      sleeper_id: sportsdataId,
      first_name: 'E2E',
      last_name: `Fallback${leagueSeasonId.slice(0, 8)}${index + 1}`,
      nba_team: 'FA',
      position: 'PG',
      eligible_positions: ['PG'],
      status: 'Active',
      injury_status: null,
      years_exp: 1,
      nba_draft_number: null,
    }
  })
  const { data, error } = await supabase
    .from('players')
    .upsert(rows, { onConflict: 'sportsdata_id' })
    .select('id, display_name, sportsdata_id')
  if (error) throw new Error(`${label}: fallback E2E player upsert failed: ${error.message}`)
  return data ?? []
}

export const writeSnapshots = async (supabase, season, leagueId) => {
  const dir = path.join(SNAPSHOT_ROOT, `season-${season}`)
  await mkdir(dir, { recursive: true })

  const summary = { counts: {} }
  for (const table of SNAPSHOT_TABLES) {
    const rows = await fetchAll(supabase, table, '*', leagueId ? { league_id: leagueId } : {})
    summary.counts[table] = rows.length
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  }
  await writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

export const indexById = (rows) => new Map(rows.map((row) => [row.id, row]))

const RESET_GROWTH_TABLES = [
  'draft_picks',
  'league_seasons',
  'waiver_priorities',
]

export const validateSnapshotProgress = (previous, current, { expectResetGrowth = false } = {}) => {
  if (!previous) return []
  const failures = []
  for (const table of SNAPSHOT_TABLES) {
    const before = previous.counts[table] ?? 0
    const after = current.counts[table] ?? 0
    if (after < before) {
      failures.push(`D.SEA.7: ${table} row count shrank from ${before} to ${after}`)
    }
  }
  if (expectResetGrowth) {
    for (const table of RESET_GROWTH_TABLES) {
      const before = previous.counts[table] ?? 0
      const after = current.counts[table] ?? 0
      if (after <= before) {
        failures.push(`D.SEA.7: ${table} row count did not grow across season reset (${before} -> ${after})`)
      }
    }
  }
  return failures
}
export const validatePerfDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(PERF_DRIFT_LIMIT) || PERF_DRIFT_LIMIT <= 1) {
    return [`D.LONG.6: invalid E2E_PERF_DRIFT_LIMIT ${process.env.E2E_PERF_DRIFT_LIMIT}`]
  }

  const baseline = median(metrics.slice(0, 3).map((metric) => metric.durationMs))
  const latest = median(metrics.slice(-3).map((metric) => metric.durationMs))
  if (!baseline || !latest) return []

  const maxAllowed = baseline * PERF_DRIFT_LIMIT
  if (latest > maxAllowed) {
    const percent = Math.round(((latest - baseline) / baseline) * 100)
    return [
      `D.LONG.6: per-season runtime median drifted ${percent}% from seasons 1-3 (${roundedMs(baseline)}ms) to seasons ${metrics.at(-3)?.season}-${metrics.at(-1)?.season} (${roundedMs(latest)}ms); limit is ${Math.round((PERF_DRIFT_LIMIT - 1) * 100)}%`,
    ]
  }
  return []
}

export const validateMemoryDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(MEMORY_DRIFT_LIMIT) || MEMORY_DRIFT_LIMIT <= 1) {
    return [`D.LONG.7: invalid E2E_MEMORY_DRIFT_LIMIT ${process.env.E2E_MEMORY_DRIFT_LIMIT}`]
  }
  if (!Number.isFinite(MEMORY_DRIFT_MIN_BYTES) || MEMORY_DRIFT_MIN_BYTES < 0) {
    return [`D.LONG.7: invalid E2E_MEMORY_DRIFT_MIN_BYTES ${process.env.E2E_MEMORY_DRIFT_MIN_BYTES}`]
  }
  if (!Number.isFinite(MEMORY_HEAP_DRIFT_MIN_BYTES) || MEMORY_HEAP_DRIFT_MIN_BYTES < 0) {
    return [`D.LONG.7: invalid E2E_MEMORY_HEAP_DRIFT_MIN_BYTES ${process.env.E2E_MEMORY_HEAP_DRIFT_MIN_BYTES}`]
  }

  const baselineSeasonStart = metrics[0]?.season
  const baselineSeasonEnd = metrics[2]?.season
  const latestSeasonStart = metrics.at(-3)?.season
  const latestMetric = metrics.at(-1)
  if (baselineSeasonStart == null || baselineSeasonEnd == null || latestSeasonStart == null || !latestMetric) return []

  const failures = []
  for (const [label, key] of [['RSS', 'rssBytes'], ['heap', 'heapUsedBytes']]) {
    const before = median(metrics.slice(0, 3).map((metric) => metric.memory?.[key]))
    const after = median(metrics.slice(-3).map((metric) => metric.memory?.[key]))
    if (!before || !after) continue
    const minBytes = key === 'heapUsedBytes' ? MEMORY_HEAP_DRIFT_MIN_BYTES : MEMORY_DRIFT_MIN_BYTES
    const maxAllowed = Math.max(before * MEMORY_DRIFT_LIMIT, before + minBytes)
    if (after > maxAllowed) {
      const percent = Math.round(((after - before) / before) * 100)
      failures.push(
        `D.LONG.7: harness ${label} memory median drifted ${percent}% from seasons ${baselineSeasonStart}-${baselineSeasonEnd} (${bytesToMiB(before)} MiB) to seasons ${latestSeasonStart}-${latestMetric.season} (${bytesToMiB(after)} MiB); limit is ${Math.round((MEMORY_DRIFT_LIMIT - 1) * 100)}%`,
      )
    }
  }
  return failures
}

export const fetchSingle = async (supabase, table, select, filters) => {
  const buildQuery = () => {
    let query = supabase.from(table).select(select)
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    return query
  }
  const { data, error } = await withSupabaseRetry(`${table} single`, () => buildQuery().single())
  if (error) throw new Error(`${table}: ${error.message ?? JSON.stringify(error)}`)
  return data
}

export const countRows = async (supabase, table, filters) => {
  const buildQuery = () => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true })
    for (const [column, value] of Object.entries(filters)) {
      query = query.eq(column, value)
    }
    return query
  }
  const { count, error } = await withSupabaseRetry(`${table} count`, () => buildQuery())
  if (error) throw new Error(`${table} count: ${error.message ?? JSON.stringify(error)}`)
  return count ?? 0
}

export const assertMatchupGenerationIdempotent = async (supabase, env, leagueId) => {
  const failures = []
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const memberCount = await countRows(supabase, 'league_members', { league_id: leagueId })
  const before = await countRows(supabase, 'matchups', {
    league_id: leagueId,
    league_season_id: currentSeason.id,
  })
  await backendJson(env, '/e2e/generate-matchups', { force: false, leagueId })
  const after = await countRows(supabase, 'matchups', {
    league_id: leagueId,
    league_season_id: currentSeason.id,
  })

  if (memberCount >= 2 && before === 0) {
    failures.push(`D.SEA.1: target league ${leagueId} has no generated matchups for current season`)
  }
  if (after !== before) {
    failures.push(`D.SEA.1: matchup generation is not idempotent (${before} -> ${after})`)
  }
  return failures
}

const createAndAcceptPickTrade = async (supabase, leagueId, seasonId, proposerId, recipientId, proposerPickId) => {
  const completedAt = new Date().toISOString()
  const { data: trade, error: tradeError } = await withSupabaseRetry('trades insert', () => supabase
      .from('trades')
      .insert({
        league_id: leagueId,
        league_season_id: seasonId,
        proposer_member_id: proposerId,
        recipient_member_id: recipientId,
        status: 'completed',
        notes: 'E2E multi-hop future-pick chain',
        accepted_at: completedAt,
        veto_window_expires_at: completedAt,
        completed_at: completedAt,
      })
      .select('id')
      .single())
  if (tradeError) throw new Error(`trades insert: ${tradeError.message}`)

  const { error: itemError } = await withSupabaseRetry('trade_items insert', () => supabase.from('trade_items').insert([
      { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPickId },
    ]))
  if (itemError) throw new Error(`trade_items insert: ${itemError.message}`)

  const { data: movedProposerPick, error: proposerMoveError } = await withSupabaseRetry('draft_picks proposer move', () => supabase
      .from('draft_picks')
      .update({ current_owner_id: recipientId })
      .eq('id', proposerPickId)
      .eq('league_id', leagueId)
      .eq('current_owner_id', proposerId)
      .eq('is_used', false)
      .select('id')
      .single())
  if (proposerMoveError || !movedProposerPick) {
    throw new Error(`draft_picks proposer move: ${proposerMoveError?.message ?? 'no row moved'}`)
  }
  return trade.id
}

export const setupFuturePickChain = async (supabase, leagueId) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  const members = await fetchAll(supabase, 'league_members', 'id, user_id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 4) throw new Error('Future-pick chain requires at least four league members')

  let targetYear = currentSeason.season_year + 5
  let targetPick = null
  let member1 = null
  for (const year of Array.from({ length: 5 }, (_, index) => currentSeason.season_year + 5 - index)) {
    const { data: candidatePicks, error: candidateError } = await withSupabaseRetry('draft_picks target pick lookup', () => supabase
        .from('draft_picks')
        .select('id, current_owner_id, original_owner_id, season_year, round')
        .eq('league_id', leagueId)
        .eq('season_year', year)
        .eq('round', 1)
        .eq('is_used', false)
        .in('original_owner_id', members.map((member) => member.id)))
    if (candidateError) throw new Error(`draft_picks target pick lookup: ${candidateError.message}`)
    targetPick = (candidatePicks ?? []).find((pick) => pick.current_owner_id === pick.original_owner_id) ?? null
    if (targetPick) {
      targetYear = year
      member1 = members.find((member) => member.id === targetPick.original_owner_id) ?? null
      break
    }
  }
  if (!targetPick || !member1) {
    throw new Error(`No self-owned round 1 pick found within the five-year horizon for league ${leagueId}`)
  }

  const [member2, member3, member4] = members
    .filter((member) => member.id !== member1.id)
    .slice(0, 3)
  if (!member2 || !member3 || !member4) throw new Error('Future-pick chain requires four distinct league members')

  const trade1 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member1.id,
    member2.id,
    targetPick.id,
  )

  const trade2 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member2.id,
    member3.id,
    targetPick.id,
  )

  const trade3 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member3.id,
    member4.id,
    targetPick.id,
  )

  return {
    targetPickId: targetPick.id,
    targetYear,
    finalOwnerId: member4.id,
    finalOwnerTeam: member4.team_name,
    tradeIds: [trade1, trade2, trade3],
    rookieDraftId: null,
    rookieDraftCheckedSeason: null,
  }
}

export const assertFuturePickMaterializedInRookieDraft = async (supabase, env, leagueId, scenario, season) => {
  if (!scenario || scenario.rookieDraftId) return null

  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  if (currentSeason.season_year < scenario.targetYear) return null

  const { draft } = await backendJson(env, '/e2e/start-rookie-draft', { leagueId })
  const { data: slot, error } = await supabase
    .from('snake_draft_picks')
    .select('id, draft_id, overall_pick, round, pick_in_round, member_id, draft_pick_id')
    .eq('draft_id', draft.id)
    .eq('draft_pick_id', scenario.targetPickId)
    .single()
  if (error || !slot) {
    throw new Error(`D.LONG.1: rookie draft ${draft.id} did not materialize target pick ${scenario.targetPickId}: ${error?.message ?? 'missing row'}`)
  }
  if (slot.member_id !== scenario.finalOwnerId) {
    throw new Error(`D.LONG.1: rookie draft slot ${slot.id} belongs to ${slot.member_id}; expected traded owner ${scenario.finalOwnerId}`)
  }

  scenario.rookieDraftId = draft.id
  scenario.rookieDraftCheckedSeason = season
  const artifact = {
    season,
    seasonYear: currentSeason.season_year,
    draftId: draft.id,
    targetPickId: scenario.targetPickId,
    expectedOwnerId: scenario.finalOwnerId,
    slot,
  }
  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${season}`, 'rookie-draft-pick-chain.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  )
  await writeFile(
    path.join(ARTIFACT_ROOT, 'future-pick-chain.json'),
    `${JSON.stringify(scenario, null, 2)}\n`,
  )
  return artifact
}

const HISTORY_WEEK_NUMBER = 99

export const sortedLeagueMembers = async (supabase, leagueId) => {
  const members = await fetchAll(supabase, 'league_members', 'id, user_id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 2) throw new Error('D.LONG.3/D.LONG.4: history scenario requires at least two league members')
  return members
}

const buildHistoryFixture = (leagueId, leagueSeason, members) => {
  const offset = Number(leagueSeason.season_year) % members.length
  const ranked = [...members.slice(offset), ...members.slice(0, offset)]
  const standings = ranked.map((member, index) => ({
    league_id: leagueId,
    league_season_id: leagueSeason.id,
    member_id: member.id,
    week_number: HISTORY_WEEK_NUMBER,
    wins: members.length - index,
    losses: index,
    ties: 0,
    points_for: 1200 - index * 25,
    points_against: 900 + index * 20,
    max_possible_points: 1300 - index * 20,
    waiver_priority: index + 1,
  }))

  return {
    leagueId,
    leagueSeasonId: leagueSeason.id,
    seasonYear: leagueSeason.season_year,
    weekNumber: HISTORY_WEEK_NUMBER,
    standings,
    championMemberId: ranked[0].id,
    runnerUpMemberId: ranked[1].id,
    championTeamName: ranked[0].team_name,
  }
}

const assertStandingMatchesFixture = (actual, expected, failures) => {
  for (const key of ['wins', 'losses', 'ties', 'waiver_priority']) {
    if (Number(actual[key]) !== Number(expected[key])) {
      failures.push(`D.LONG.3: standing ${actual.id} ${key}=${actual[key]}; expected ${expected[key]}`)
    }
  }
  for (const key of ['points_for', 'points_against', 'max_possible_points']) {
    if (Number(actual[key]) !== Number(expected[key])) {
      failures.push(`D.LONG.3: standing ${actual.id} ${key}=${actual[key]}; expected ${expected[key]}`)
    }
  }
}

export const ensureHistoryFixtureForSeason = async (supabase, leagueId, leagueSeason) => {
  const members = await sortedLeagueMembers(supabase, leagueId)
  const fixture = buildHistoryFixture(leagueId, leagueSeason, members)

  const { data: existingStandings, error: standingsReadError } = await supabase
    .from('standings')
    .select('id, member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeason.id)
    .eq('week_number', HISTORY_WEEK_NUMBER)
  if (standingsReadError) throw new Error(`D.LONG.3 standings read: ${standingsReadError.message}`)

  if ((existingStandings ?? []).length === 0) {
    const { error } = await supabase.from('standings').insert(fixture.standings)
    if (error) throw new Error(`D.LONG.3 standings fixture insert: ${error.message}`)
  }

  const { data: existingFinals, error: finalsReadError } = await supabase
    .from('matchups')
    .select('id, home_member_id, away_member_id, winner_member_id, is_finalized')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeason.id)
    .eq('week_number', HISTORY_WEEK_NUMBER + 1)
    .eq('matchup_type', 'playoff_final')
  if (finalsReadError) throw new Error(`D.LONG.4 champion read: ${finalsReadError.message}`)

  const matchingFinal = (existingFinals ?? []).find((row) => (
    row.home_member_id === fixture.championMemberId &&
    row.away_member_id === fixture.runnerUpMemberId
  ))
  if (!matchingFinal) {
    const { data: finalRow, error } = await supabase
      .from('matchups')
      .insert({
        league_id: leagueId,
        league_season_id: leagueSeason.id,
        week_number: HISTORY_WEEK_NUMBER + 1,
        matchup_type: 'playoff_final',
        home_member_id: fixture.championMemberId,
        away_member_id: fixture.runnerUpMemberId,
        home_points: 110,
        away_points: 100,
        home_max_possible_points: 120,
        away_max_possible_points: 112,
        winner_member_id: fixture.championMemberId,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(`D.LONG.4 champion fixture insert: ${error.message}`)
    fixture.championMatchupId = finalRow.id
  } else {
    fixture.championMatchupId = matchingFinal.id
  }

  return fixture
}

export const assertHistoryRetained = async (supabase, fixtures, runSeason) => {
  const failures = []
  const retained = []
  for (const fixture of fixtures) {
    const { data: standings, error: standingsError } = await supabase
      .from('standings')
      .select('id, member_id, wins, losses, ties, points_for, points_against, max_possible_points, waiver_priority')
      .eq('league_id', fixture.leagueId)
      .eq('league_season_id', fixture.leagueSeasonId)
      .eq('week_number', fixture.weekNumber)
    if (standingsError) {
      failures.push(`D.LONG.3: standings history query failed for ${fixture.seasonYear}: ${standingsError.message}`)
      continue
    }

    const byMember = new Map((standings ?? []).map((row) => [row.member_id, row]))
    for (const expected of fixture.standings) {
      const actual = byMember.get(expected.member_id)
      if (!actual) {
        failures.push(`D.LONG.3: season ${fixture.seasonYear} missing historical standing for member ${expected.member_id}`)
        continue
      }
      assertStandingMatchesFixture(actual, expected, failures)
    }

    const { data: final, error: finalError } = await supabase
      .from('matchups')
      .select('id, winner_member_id, is_finalized')
      .eq('id', fixture.championMatchupId)
      .single()
    if (finalError || !final) {
      failures.push(`D.LONG.4: champion matchup ${fixture.championMatchupId} is not queryable: ${finalError?.message ?? 'missing row'}`)
    } else if (!final.is_finalized || final.winner_member_id !== fixture.championMemberId) {
      failures.push(`D.LONG.4: champion history for ${fixture.seasonYear} resolved to ${final.winner_member_id}; expected ${fixture.championMemberId}`)
    }

    retained.push({
      seasonYear: fixture.seasonYear,
      leagueSeasonId: fixture.leagueSeasonId,
      standingsRows: standings?.length ?? 0,
      championMatchupId: fixture.championMatchupId,
      championMemberId: fixture.championMemberId,
      championTeamName: fixture.championTeamName,
    })
  }

  await writeFile(
    path.join(ARTIFACT_ROOT, `season-${runSeason}`, 'history-retention.json'),
    `${JSON.stringify({ runSeason, retained }, null, 2)}\n`,
  )
  return failures
}
