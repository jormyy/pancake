import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { createFakeUpstreamServer } from './fake-upstream.mjs'
import { resolvedEnv, describeEndpoint } from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-report.md')
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const SNAPSHOT_ROOT = path.join(ROOT, 'tests/snapshots')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')

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
  }
}

const timestamp = () => new Date().toISOString()

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

const writeSnapshots = async (supabase, season, leagueId) => {
  const dir = path.join(SNAPSHOT_ROOT, `season-${season}`)
  await mkdir(dir, { recursive: true })

  for (const table of SNAPSHOT_TABLES) {
    const rows = await fetchAll(supabase, table, '*', leagueId ? { league_id: leagueId } : {})
    await writeFile(path.join(dir, `${table}.json`), `${JSON.stringify(rows, null, 2)}\n`)
  }
}

const indexById = (rows) => new Map(rows.map((row) => [row.id, row]))

const runInvariants = async (supabase, leagueId) => {
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
    fetchAll(supabase, 'draft_picks', 'id, league_id, current_owner_id, original_owner_id', leagueFilter),
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
    'Browser-driving scenarios must be run with agent-browser against the configured frontend before declaring the app dynasty-stable.',
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

    const fake = createFakeUpstreamServer()
    await fake.listen(args.fakePort)

    try {
      if (env.backendTicksEnabled) {
        await backendGetJson(env, '/e2e/status')
      }

      for (let season = 1; season <= args.seasons; season += 1) {
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

        const failuresAtStart = await runInvariants(supabase, targetLeagueId)
        await writeSnapshots(supabase, season, targetLeagueId)
        const failuresAtEnd = await runInvariants(supabase, targetLeagueId)
        const failures = [...failuresAtStart, ...failuresAtEnd]

        if (failures.length > 0) {
          rows.push({ season, status: 'FAIL', notes: failures.join('; ') })
          if (!args.keepGoing) break
        } else {
          rows.push({ season, status: 'PASS', notes: 'D.0 invariant boundary checks passed; scenario/browser steps pending' })
        }

        await postJson(`http://127.0.0.1:${args.fakePort}/admin/advance-season`, {})
      }
    } finally {
      await fake.close()
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
