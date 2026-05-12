import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { createFakeUpstreamServer } from './fake-upstream.mjs'
import { resolvedEnv, describeEndpoint } from './env.mjs'
import { runBrowserSmoke } from './browser-smoke.mjs'
import { runBrowserAuthScenario } from './browser-auth.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-report.md')
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const SNAPSHOT_ROOT = path.join(ROOT, 'tests/snapshots')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const PERF_METRICS_PATH = path.join(ARTIFACT_ROOT, 'perf-metrics.json')
const PERF_DRIFT_LIMIT = Number(process.env.E2E_PERF_DRIFT_LIMIT ?? 1.2)

const SNAPSHOT_TABLES = [
  'roster_players',
  'draft_picks',
  'standings',
  'league_seasons',
  'waiver_priorities',
]

const parseArgs = () => {
  const args = new Map()
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/)
    if (match) args.set(match[1], match[2])
  }
  return {
    seasons: Number(args.get('seasons') ?? process.env.E2E_SEASONS ?? 10),
    keepGoing: args.get('keep-going') === 'true' || process.env.E2E_KEEP_GOING === '1',
    fakePort: Number(args.get('fake-port') ?? process.env.FAKE_UPSTREAM_PORT ?? 4555),
    browser: args.get('browser') === 'true' || process.env.E2E_ENABLE_BROWSER === '1',
    browserAuth: args.get('browser-auth') === 'true' || process.env.E2E_ENABLE_BROWSER_AUTH === '1',
    pickChain: args.get('pick-chain') === 'true' || process.env.E2E_ENABLE_PICK_CHAIN === '1',
  }
}

const timestamp = () => new Date().toISOString()
const nowMs = () => Number(process.hrtime.bigint()) / 1_000_000

const roundedMs = (value) => Math.round(value)

const readState = async () => {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const writeReport = async ({ status, startedAt, finishedAt, seasons, rows, notes }) => {
  const lines = [
    '# Multi-Season E2E Soak Report',
    '',
    `- Status: ${status}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Target seasons: ${seasons}`,
    `- Fake upstream: http://127.0.0.1:${process.env.FAKE_UPSTREAM_PORT ?? 4555}`,
    '',
    '## Season Summary',
    '',
    '| Season | Status | Notes |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.season} | ${row.status} | ${row.notes.replaceAll('\n', '<br>')} |`),
    '',
    '## Notes',
    '',
    ...notes.map((note) => `- ${note}`),
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

const assertEnv = async (seasons) => {
  const env = resolvedEnv()
  const missing = []
  if (!env.supabaseUrl) missing.push('E2E_SUPABASE_URL or SUPABASE_URL')
  if (!env.serviceRoleKey) missing.push('E2E_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length === 0) return

  const now = timestamp()
  await writeReport({
    status: 'BLOCKED',
    startedAt: now,
    finishedAt: now,
    seasons,
    rows: [{ season: 0, status: 'BLOCKED', notes: `Missing env: ${missing.join(', ')}` }],
    notes: [
      'The soak runner loads .env and backend/.env, then fails closed until Supabase service credentials are available.',
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

const runSchemaPreflight = async (supabase) => {
  const zeroUuid = '00000000-0000-0000-0000-000000000000'
  const checks = await Promise.all([
    requireRpc(supabase, 'release_live_poll_lock', {}, null),
    requireRpc(supabase, 'accept_trade_atomic', { p_trade_id: zeroUuid, p_accepting_member_id: zeroUuid }, /Trade not found/i),
    requireRpc(supabase, 'advance_season_atomic', { p_league_id: zeroUuid }, /League not found/i),
    requireRpc(
      supabase,
      'place_auction_bid_atomic',
      { p_draft_id: zeroUuid, p_member_id: zeroUuid, p_nomination_id: zeroUuid, p_amount: 0 },
      /positive integer/i,
    ),
    requireRpc(supabase, 'process_next_waiver_claim_atomic', { p_process_date: '1900-01-01' }, null),
    requireColumn(supabase, 'snake_draft_picks', 'draft_pick_id'),
  ])
  return checks.filter(Boolean)
}

const fetchAll = async (supabase, table, select = '*', filters = {}) => {
  const pageSize = 1000
  const rows = []
  let from = 0

  while (true) {
    let query = supabase
      .from(table)
      .select(select)
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

const summarizeSnapshot = (tableRows) => {
  const summary = { counts: {} }
  for (const [table, rows] of Object.entries(tableRows)) {
    summary.counts[table] = rows.length
  }
  return summary
}

const writeSnapshots = async (supabase, season, leagueId) => {
  const dir = path.join(SNAPSHOT_ROOT, `season-${season}`)
  await mkdir(dir, { recursive: true })

  const tableRows = {}
  for (const table of SNAPSHOT_TABLES) {
    const rows = await fetchAll(supabase, table, '*', leagueId ? { league_id: leagueId } : {})
    tableRows[table] = rows
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  }
  const summary = summarizeSnapshot(tableRows)
  await writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

const indexById = (rows) => new Map(rows.map((row) => [row.id, row]))

const RESET_GROWTH_TABLES = [
  'draft_picks',
  'league_seasons',
  'waiver_priorities',
]

const validateSnapshotProgress = (previous, current, { expectResetGrowth = false } = {}) => {
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

const validatePerfDrift = (metrics, totalSeasons) => {
  if (totalSeasons < 10 || metrics.length < 10) return []
  if (!Number.isFinite(PERF_DRIFT_LIMIT) || PERF_DRIFT_LIMIT <= 1) {
    return [`D.LONG.6: invalid E2E_PERF_DRIFT_LIMIT ${process.env.E2E_PERF_DRIFT_LIMIT}`]
  }

  const baseline = metrics[0]?.durationMs
  const latest = metrics.at(-1)?.durationMs
  if (!baseline || !latest) return []

  const maxAllowed = baseline * PERF_DRIFT_LIMIT
  if (latest > maxAllowed) {
    const percent = Math.round(((latest - baseline) / baseline) * 100)
    return [
      `D.LONG.6: per-season runtime drifted ${percent}% from season 1 (${roundedMs(baseline)}ms) to season ${metrics.at(-1).season} (${roundedMs(latest)}ms); limit is ${Math.round((PERF_DRIFT_LIMIT - 1) * 100)}%`,
    ]
  }
  return []
}

const fetchSingle = async (supabase, table, select, filters) => {
  let query = supabase.from(table).select(select)
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value)
  }
  const { data, error } = await query.single()
  if (error) throw new Error(`${table}: ${error.message}`)
  return data
}

const countRows = async (supabase, table, filters) => {
  let query = supabase.from(table).select('id', { count: 'exact', head: true })
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value)
  }
  const { count, error } = await query
  if (error) throw new Error(`${table} count: ${error.message}`)
  return count ?? 0
}

const assertMatchupGenerationIdempotent = async (supabase, env, leagueId) => {
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
  await backendJson(env, '/e2e/generate-matchups', { force: false })
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

const createAndAcceptPickTrade = async (supabase, leagueId, seasonId, proposerId, recipientId, proposerPickId, recipientPickId) => {
  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      league_id: leagueId,
      league_season_id: seasonId,
      proposer_member_id: proposerId,
      recipient_member_id: recipientId,
      status: 'pending',
      notes: 'E2E multi-hop future-pick chain',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`trades insert: ${tradeError.message}`)

  const { error: itemError } = await supabase.from('trade_items').insert([
    { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPickId },
    { trade_id: trade.id, side: 'recipient', player_id: null, pick_id: recipientPickId },
  ])
  if (itemError) throw new Error(`trade_items insert: ${itemError.message}`)

  const { error: acceptError } = await supabase.rpc('accept_trade_atomic', {
    p_trade_id: trade.id,
    p_accepting_member_id: recipientId,
  })
  if (acceptError) throw new Error(`accept_trade_atomic: ${acceptError.message}`)

  return trade.id
}

const findOwnedPick = async (supabase, leagueId, seasonYear, round, ownerId, excludePickId = null) => {
  let query = supabase
    .from('draft_picks')
    .select('id, current_owner_id, original_owner_id, season_year, round')
    .eq('league_id', leagueId)
    .eq('season_year', seasonYear)
    .eq('round', round)
    .eq('current_owner_id', ownerId)
    .eq('is_used', false)
    .limit(1)
  if (excludePickId) query = query.neq('id', excludePickId)

  const { data, error } = await query
  if (error) throw new Error(`draft_picks owned pick lookup: ${error.message}`)
  const [pick] = data ?? []
  if (!pick) throw new Error(`No owned ${seasonYear} round ${round} pick for member ${ownerId}`)
  return pick
}

const setupFuturePickChain = async (supabase, leagueId) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id, season_year',
    { league_id: leagueId, is_current: true },
  )
  const members = await fetchAll(supabase, 'league_members', 'id, team_name, joined_at', { league_id: leagueId })
  members.sort((a, b) => {
    const joined = String(a.joined_at).localeCompare(String(b.joined_at))
    return joined === 0 ? String(a.id).localeCompare(String(b.id)) : joined
  })
  if (members.length < 4) throw new Error('Future-pick chain requires at least four league members')

  const targetYear = currentSeason.season_year + 5
  const [member1, member2, member3, member4] = members
  const targetPick = await fetchSingle(
    supabase,
    'draft_picks',
    'id, current_owner_id, original_owner_id, season_year, round',
    {
      league_id: leagueId,
      season_year: targetYear,
      round: 1,
      original_owner_id: member1.id,
      current_owner_id: member1.id,
    },
  )

  const counter1 = await findOwnedPick(supabase, leagueId, targetYear, 2, member2.id, targetPick.id)
  const trade1 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member1.id,
    member2.id,
    targetPick.id,
    counter1.id,
  )

  const counter2 = await findOwnedPick(supabase, leagueId, targetYear, 2, member3.id, targetPick.id)
  const trade2 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member2.id,
    member3.id,
    targetPick.id,
    counter2.id,
  )

  const counter3 = await findOwnedPick(supabase, leagueId, targetYear, 2, member4.id, targetPick.id)
  const trade3 = await createAndAcceptPickTrade(
    supabase,
    leagueId,
    currentSeason.id,
    member3.id,
    member4.id,
    targetPick.id,
    counter3.id,
  )

  return {
    targetPickId: targetPick.id,
    targetYear,
    finalOwnerId: member4.id,
    finalOwnerTeam: member4.team_name,
    tradeIds: [trade1, trade2, trade3],
  }
}

const runInvariants = async (supabase, leagueId, scenarios = {}) => {
  const leagueFilter = leagueId ? { league_id: leagueId } : {}
  const [
    leagues,
    leagueSeasons,
    leagueMembers,
    rosterPlayers,
    weeklyLineups,
    waiverClaims,
    trades,
    tradeItems,
    draftPicks,
    drafts,
    nominations,
  ] = await Promise.all([
    leagueId ? fetchAll(supabase, 'leagues', 'id', { id: leagueId }) : fetchAll(supabase, 'leagues', 'id'),
    fetchAll(supabase, 'league_seasons', 'id, league_id, is_current', leagueFilter),
    fetchAll(supabase, 'league_members', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'roster_players', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'weekly_lineups', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'waiver_claims', 'id, league_id, league_season_id, member_id, player_id, drop_player_id, status, process_date', leagueFilter),
    fetchAll(supabase, 'trades', 'id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, veto_window_expires_at', leagueFilter),
    fetchAll(supabase, 'trade_items', 'id, trade_id, player_id, pick_id'),
    fetchAll(supabase, 'draft_picks', 'id, league_id, season_year, round, current_owner_id, original_owner_id', leagueFilter),
    fetchAll(supabase, 'drafts', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at'),
  ])

  const failures = []
  const leagueIds = new Set(leagues.map((row) => row.id))
  const seasonIds = indexById(leagueSeasons)
  const membersById = indexById(leagueMembers)
  const draftIds = new Set(drafts.map((draft) => draft.id))
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const scopedTradeItems = leagueId ? tradeItems.filter((item) => tradeIds.has(item.trade_id)) : tradeItems
  const scopedNominations = leagueId ? nominations.filter((nomination) => draftIds.has(nomination.draft_id)) : nominations

  if (leagues.length === 0) {
    failures.push(leagueId ? `D.SET.2: target league ${leagueId} does not exist` : 'D.SET.2: no leagues exist in the test project')
  }

  for (const league of leagues) {
    const current = leagueSeasons.filter((season) => season.league_id === league.id && season.is_current)
    if (current.length !== 1) {
      failures.push(`I0: league ${league.id} has ${current.length} current seasons`)
      continue
    }

    const [currentSeason] = current
    const members = leagueMembers.filter((member) => member.league_id === league.id)
    const memberIds = new Set(members.map((member) => member.id))
    const pickKeys = new Set(
      draftPicks
        .filter((pick) => pick.league_id === league.id)
        .map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}`),
    )
    const currentYear = currentSeason.season_year
    for (let seasonYear = currentYear + 1; seasonYear <= currentYear + 5; seasonYear += 1) {
      for (let round = 1; round <= 3; round += 1) {
        for (const memberId of memberIds) {
          if (!pickKeys.has(`${seasonYear}:${round}:${memberId}`)) {
            failures.push(`D.SEA.6: league ${league.id} missing future pick ${seasonYear} round ${round} for member ${memberId}`)
          }
        }
      }
    }
  }

  for (const pick of draftPicks) {
    const owner = membersById.get(pick.current_owner_id)
    const originalOwner = membersById.get(pick.original_owner_id)
    if (!owner || owner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} current_owner_id does not resolve within league`)
    }
    if (!originalOwner || originalOwner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} original_owner_id does not resolve within league`)
    }
  }

  if (scenarios.futurePickChain) {
    const targetPick = draftPicks.find((pick) => pick.id === scenarios.futurePickChain.targetPickId)
    if (!targetPick) {
      failures.push(`D.LONG.2: target multi-hop pick ${scenarios.futurePickChain.targetPickId} is missing`)
    } else if (targetPick.current_owner_id !== scenarios.futurePickChain.finalOwnerId) {
      failures.push(
        `D.LONG.2: target multi-hop pick ${targetPick.id} owner drifted to ${targetPick.current_owner_id}; expected ${scenarios.futurePickChain.finalOwnerId}`,
      )
    }
  }

  const rosterKeys = new Set()
  for (const rosterPlayer of rosterPlayers) {
    const key = `${rosterPlayer.league_id}:${rosterPlayer.league_season_id}:${rosterPlayer.player_id}`
    if (rosterKeys.has(key)) {
      failures.push(`I3: duplicate roster player ownership for ${key}`)
    }
    rosterKeys.add(key)
  }

  const assertLeagueSeasonMember = (label, row, memberKeys) => {
    if (!leagueIds.has(row.league_id)) failures.push(`I6: ${label} ${row.id} has orphan league_id`)
    if (!seasonIds.has(row.league_season_id)) failures.push(`I6: ${label} ${row.id} has orphan league_season_id`)
    for (const key of memberKeys) {
      const member = membersById.get(row[key])
      if (!member || member.league_id !== row.league_id) {
        failures.push(`I6: ${label} ${row.id} has invalid ${key}`)
      }
    }
  }

  for (const row of rosterPlayers) assertLeagueSeasonMember('roster_players', row, ['member_id'])
  for (const row of weeklyLineups) assertLeagueSeasonMember('weekly_lineups', row, ['member_id'])
  for (const row of waiverClaims) assertLeagueSeasonMember('waiver_claims', row, ['member_id'])
  for (const row of trades) assertLeagueSeasonMember('trades', row, ['proposer_member_id', 'recipient_member_id'])

  const pickIds = new Set(draftPicks.map((pick) => pick.id))
  for (const item of scopedTradeItems) {
    if (!tradeIds.has(item.trade_id)) failures.push(`I6: trade_items ${item.id} has orphan trade_id`)
    if (item.pick_id && !pickIds.has(item.pick_id)) failures.push(`I6: trade_items ${item.id} has orphan pick_id`)
  }

  const now = new Date()
  for (const nomination of scopedNominations) {
    if (
      nomination.status === 'open' &&
      nomination.countdown_expires_at &&
      new Date(nomination.countdown_expires_at) < now
    ) {
      failures.push(`I7: nomination ${nomination.id} is open past countdown_expires_at`)
    }
  }

  for (const trade of trades) {
    if (
      trade.status === 'accepted' &&
      trade.veto_window_expires_at &&
      new Date(trade.veto_window_expires_at) < now
    ) {
      failures.push(`I7: trade ${trade.id} is pending completion past veto_window_expires_at`)
    }
  }

  const today = now.toISOString().slice(0, 10)
  for (const claim of waiverClaims) {
    if (claim.status === 'pending' && claim.process_date < today) {
      failures.push(`I7: waiver_claim ${claim.id} is pending past process_date`)
    }
  }

  return failures
}

const postJson = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url} returned ${response.status}`)
  return response.json()
}

const backendUrl = (env, pathname) => new URL(pathname, env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`).toString()

const backendJson = async (env, pathname, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-e2e-secret': env.e2eAdminSecret,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

const backendGetJson = async (env, pathname) => {
  const response = await fetch(backendUrl(env, pathname), {
    headers: { 'x-e2e-secret': env.e2eAdminSecret },
  })
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}`)
  return response.json()
}

const assertCorsPreflight = async (env) => {
  const origin = new URL(env.frontendUrl).origin
  const response = await fetch(backendUrl(env, '/e2e/status'), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type,x-e2e-secret,authorization',
    },
  })
  if (!response.ok && response.status !== 204) {
    throw new Error(`D.X.3: CORS preflight returned ${response.status}`)
  }

  const allowOrigin = response.headers.get('access-control-allow-origin')
  if (allowOrigin !== origin && allowOrigin !== '*') {
    throw new Error(`D.X.3: CORS allow-origin was ${allowOrigin ?? '<missing>'}; expected ${origin}`)
  }

  const allowMethods = response.headers.get('access-control-allow-methods') ?? ''
  if (!allowMethods.split(',').map((method) => method.trim().toUpperCase()).includes('GET')) {
    throw new Error(`D.X.3: CORS allow-methods missing GET: ${allowMethods || '<missing>'}`)
  }

  const allowHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
  for (const header of ['content-type', 'x-e2e-secret', 'authorization']) {
    if (!allowHeaders.includes(header)) {
      throw new Error(`D.X.3: CORS allow-headers missing ${header}: ${allowHeaders || '<missing>'}`)
    }
  }
}

const main = async () => {
  const args = parseArgs()
  if (!Number.isInteger(args.seasons) || args.seasons < 1) {
    throw new Error('--seasons must be a positive integer')
  }

  process.env.FAKE_UPSTREAM_PORT = String(args.fakePort)
  await assertEnv(args.seasons)
  const env = resolvedEnv()
  const state = await readState()
  const targetLeagueId = process.env.E2E_LEAGUE_ID ?? state?.leagueId ?? null
  if (env.backendTicksEnabled && !env.e2eAdminSecret) {
    throw new Error('E2E_ENABLE_BACKEND_TICKS=1 requires E2E_ADMIN_SECRET')
  }
  if (env.backendTicksEnabled && !targetLeagueId) {
    throw new Error('E2E_ENABLE_BACKEND_TICKS=1 requires a seeded target league or E2E_LEAGUE_ID')
  }
  if (args.pickChain && !targetLeagueId) {
    throw new Error('E2E_ENABLE_PICK_CHAIN=1 requires a seeded target league or E2E_LEAGUE_ID')
  }

  const startedAt = timestamp()
  const rows = []
  const notes = [
    'This harness is integration/E2E only. It does not run unit tests.',
    `Configured API base: ${describeEndpoint(env.apiBaseUrl)}`,
    `Configured frontend: ${describeEndpoint(env.frontendUrl)}`,
    targetLeagueId
      ? `Target league: ${targetLeagueId}${state?.runId ? ` (seed run ${state.runId})` : ''}`
      : 'No target league was configured; invariants will scan all leagues in the configured Supabase project.',
    env.backendTicksEnabled
      ? 'Backend tick endpoints enabled through E2E_ENABLE_BACKEND_TICKS=1.'
      : 'Backend tick endpoints were not enabled; set E2E_ENABLE_BACKEND_TICKS=1 with a local backend to run them.',
    args.browser
      ? 'Browser smoke enabled through E2E_ENABLE_BROWSER=1.'
      : 'Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.',
    args.browserAuth
      ? 'Browser auth scenario enabled through E2E_ENABLE_BROWSER_AUTH=1.'
      : 'Browser auth/sign-out/session-persistence scenario disabled; set E2E_ENABLE_BROWSER_AUTH=1 to exercise D.SET.1.',
    args.pickChain
      ? 'Future-pick multi-hop scenario enabled through E2E_ENABLE_PICK_CHAIN=1.'
      : 'Future-pick multi-hop scenario disabled; set E2E_ENABLE_PICK_CHAIN=1 to exercise D.LONG.2.',
  ]

  try {
    const supabase = createClient(
      env.supabaseUrl,
      env.serviceRoleKey,
      { auth: { persistSession: false } },
    )
    const schemaFailures = await runSchemaPreflight(supabase)
    if (schemaFailures.length > 0) {
      await writeReport({
        status: 'BLOCKED',
        startedAt,
        finishedAt: timestamp(),
        seasons: args.seasons,
        rows: [{ season: 0, status: 'BLOCKED', notes: `Schema preflight failed: ${schemaFailures.join('; ')}` }],
        notes: [
          ...notes,
          'Apply the post-refactor Supabase migrations before running the multi-season soak.',
        ],
      })
      process.exitCode = 1
      return
    }
    notes.push('Schema preflight passed: post-refactor RPCs and required columns are present.')
    const scenarios = {}
    if (args.pickChain) {
      scenarios.futurePickChain = await setupFuturePickChain(supabase, targetLeagueId)
      await mkdir(ARTIFACT_ROOT, { recursive: true })
      await writeFile(
        path.join(ARTIFACT_ROOT, 'future-pick-chain.json'),
        `${JSON.stringify(scenarios.futurePickChain, null, 2)}\n`,
      )
      notes.push(
        `Future-pick chain: ${scenarios.futurePickChain.targetYear} round 1 pick ${scenarios.futurePickChain.targetPickId} now belongs to ${scenarios.futurePickChain.finalOwnerTeam}.`,
      )
    }

    const fake = createFakeUpstreamServer()
    await fake.listen(args.fakePort)

    try {
      if (env.backendTicksEnabled) {
        await backendGetJson(env, '/e2e/status')
        await assertCorsPreflight(env)
        notes.push('CORS preflight check passed for the configured frontend origin.')
      }

      let previousSnapshot = null
      const perfMetrics = []
      for (let season = 1; season <= args.seasons; season += 1) {
        const seasonStartedMs = nowMs()
        await mkdir(path.join(ARTIFACT_ROOT, `season-${season}`), { recursive: true })
        await postJson(`http://127.0.0.1:${args.fakePort}/admin/now`, {
          now: `${2026 + season}-10-20T12:00:00.000Z`,
        })

        if (env.backendTicksEnabled) {
          await backendJson(env, '/e2e/sync-schedule')
          await backendJson(env, '/e2e/sync-players')
          await backendJson(env, '/e2e/live-poll', { date: `${2026 + season}-10-20T12:00:00.000Z` })
          await backendJson(env, '/e2e/process-waivers')
          await backendJson(env, '/e2e/generate-matchups', { force: false })
        }

        if (args.browser) {
          await runBrowserSmoke({ season })
        }
        if (args.browserAuth) {
          await runBrowserAuthScenario({ season })
        }

        const failuresAtStart = await runInvariants(supabase, targetLeagueId, scenarios)
        const failuresAtEnd = await runInvariants(supabase, targetLeagueId, scenarios)
        const matchupFailures = env.backendTicksEnabled
          ? await assertMatchupGenerationIdempotent(supabase, env, targetLeagueId)
          : []
        const failuresAfterReset = []
        if (env.backendTicksEnabled) {
          await backendJson(env, '/e2e/advance-season', { leagueId: targetLeagueId })
          failuresAfterReset.push(...await runInvariants(supabase, targetLeagueId, scenarios))
        }
        const snapshot = await writeSnapshots(supabase, season, targetLeagueId)
        const hadPreviousSnapshot = previousSnapshot != null
        const snapshotFailures = validateSnapshotProgress(previousSnapshot, snapshot, {
          expectResetGrowth: env.backendTicksEnabled,
        })
        previousSnapshot = snapshot
        const durationMs = nowMs() - seasonStartedMs
        perfMetrics.push({ season, durationMs: roundedMs(durationMs) })
        await mkdir(ARTIFACT_ROOT, { recursive: true })
        await writeFile(PERF_METRICS_PATH, `${JSON.stringify({
          driftLimit: PERF_DRIFT_LIMIT,
          metrics: perfMetrics,
        }, null, 2)}\n`)
        const perfFailures = validatePerfDrift(perfMetrics, args.seasons)
        const failures = [
          ...failuresAtStart,
          ...failuresAtEnd,
          ...matchupFailures,
          ...failuresAfterReset,
          ...snapshotFailures,
          ...perfFailures,
        ]

        if (failures.length > 0) {
          rows.push({ season, status: 'FAIL', notes: failures.join('; ') })
          if (!args.keepGoing) break
        } else {
          const seasonNotes = env.backendTicksEnabled
            ? 'D.0 invariant boundary checks passed before and after real season reset; full scenario loop pending'
            : 'D.0 invariant boundary checks passed; full scenario/browser loop pending'
          rows.push({
            season,
            status: 'PASS',
            notes: [
              seasonNotes,
              args.browser ? 'browser smoke passed' : null,
              args.browserAuth ? 'browser auth scenario passed' : null,
              env.backendTicksEnabled ? 'matchup generation idempotency passed' : null,
              args.pickChain ? 'multi-hop future-pick owner resolved' : null,
              hadPreviousSnapshot ? 'snapshot row-count diff passed' : null,
              args.seasons >= 10 && season >= 10 ? 'runtime drift check passed' : null,
            ].filter(Boolean).join('; '),
          })
        }

        await postJson(`http://127.0.0.1:${args.fakePort}/admin/advance-season`, {})
      }
    } finally {
      await fake.close()
    }

    if (rows.length > 0) {
      notes.push(`Perf metrics written to ${path.relative(ROOT, PERF_METRICS_PATH)}.`)
    }

    const status = rows.some((row) => row.status === 'FAIL') ? 'FAIL' : 'PARTIAL'
    await writeReport({
      status,
      startedAt,
      finishedAt: timestamp(),
      seasons: args.seasons,
      rows,
      notes,
    })

    if (status !== 'PASS') process.exitCode = 1
  } catch (error) {
    throw error
  }
}

main().catch(async (error) => {
  if (!String(error.message).startsWith('Missing required soak environment:')) {
    const now = timestamp()
    await writeReport({
      status: 'ERROR',
      startedAt: now,
      finishedAt: now,
      seasons: Number(process.env.E2E_SEASONS ?? 10),
      rows: [{ season: 0, status: 'ERROR', notes: error instanceof Error ? error.message : String(error) }],
      notes: ['The soak runner failed before completing the requested season loop.'],
    })
  }
  console.error(error)
  process.exitCode = 1
})
