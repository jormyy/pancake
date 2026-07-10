import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'
import { createScenarioResourceOwner } from './scenario-resource-owner.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-seed-report.md')
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')

const EXPECTED_LINEUP_SLOTS = {
  PG: 1,
  SG: 1,
  SF: 1,
  PF: 1,
  C: 1,
  G: 1,
  F: 1,
  UTIL: 3,
  BE: 10,
  IR: 2,
}

const currentSeasonYear = (now = new Date()) => {
  return now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
}

const expectedSlotDetail = () => Object.entries(EXPECTED_LINEUP_SLOTS)
  .map(([slot, count]) => `${slot}:${count}`)
  .join(', ')

const seedPlayerFixtures = async (admin) => {
  const positions = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
  const teams = ['ATL', 'BOS', 'CHI', 'DAL', 'DEN', 'GSW', 'LAL', 'MIA']
  const players = Array.from({ length: 80 }, (_, index) => {
    const n = index + 1
    const position = positions[index % positions.length]
    return {
      sportsdata_id: `e2e-player-${String(n).padStart(3, '0')}`,
      nba_id: `E2ENBA${String(n).padStart(3, '0')}`,
      sleeper_id: `e2e-sleeper-${String(n).padStart(3, '0')}`,
      first_name: 'E2E',
      last_name: `Player${String(n).padStart(3, '0')}`,
      nba_team: teams[index % teams.length],
      position,
      eligible_positions: [position],
      status: 'Active',
      injury_status: null,
      years_exp: index < 20 ? 0 : 3,
      nba_draft_number: index < 20 ? n : null,
    }
  })

  const { error } = await admin
    .from('players')
    .upsert(players, { onConflict: 'sportsdata_id' })
  if (error) throw new Error(`players fixture upsert: ${error.message}`)

  const { count, error: countError } = await admin
    .from('players')
    .select('id', { count: 'exact', head: true })
    .like('sportsdata_id', 'e2e-player-%')
  if (countError) throw new Error(`players fixture count: ${countError.message}`)
  return count ?? 0
}

const writeReport = async ({ runId, league, users, checks, cleanupError = null }) => {
  const lines = [
    '# E2E Seed Report',
    '',
    `- Run ID: ${runId}`,
    `- League ID: ${league?.id ?? '<not-created>'}`,
    `- Invite Code: ${league?.invite_code ?? '<not-created>'}`,
    `- Users: ${users.length}`,
    `- Cleanup: ${cleanupError ?? 'clean'}`,
    '',
    '## Checks',
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...checks.map((check) => `| ${check.name} | ${check.status} | ${check.detail} |`),
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

const errorText = (error) => error instanceof AggregateError
  ? `${error.message}: ${error.errors.map(errorText).join('; ')}`
  : error instanceof Error ? error.message : String(error)

const LEAGUE_MEMBER_DEPENDENT_TABLES = [
  'bids',
  'trades',
  'drafts',
  'draft_picks',
  'matchups',
  'roster_transactions',
  'roster_players',
  'rps_challenges',
  'standings',
  'waiver_claims',
  'waiver_priorities',
  'waiver_wire_log',
  'weekly_lineups',
]

const deleteLeague = async (admin, leagueId, label) => {
  const { error: terminalError } = await admin.from('trades')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
    .eq('league_id', leagueId)
    .eq('status', 'accepted')
  const childFailures = []
  for (const table of LEAGUE_MEMBER_DEPENDENT_TABLES) {
    const { error } = await admin.from(table).delete().eq('league_id', leagueId)
    if (error) childFailures.push(new Error(`${table}: ${error.message}`))
  }
  const { error: deleteError } = await admin.from('leagues').delete().eq('id', leagueId)
  const failures = [
    ...[terminalError, deleteError].filter(Boolean).map((error) => new Error(error.message)),
    ...childFailures,
  ]
  if (failures.length > 0) throw new AggregateError(failures, `${label} league cleanup failed`)
}

const deleteUser = async (admin, userId, label) => {
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error && !/not found/i.test(error.message)) throw new Error(`${label} user cleanup ${userId}: ${error.message}`)
}

const readPreviousState = async (statePath) => {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export const cleanupPreviousSeed = async (admin, statePath = STATE_PATH) => {
  const previous = await readPreviousState(statePath)
  if (!previous) return
  const failures = []
  if (previous.leagueId) {
    try {
      await deleteLeague(admin, previous.leagueId, 'previous seed')
    } catch (error) {
      failures.push(error)
    }
  }
  for (const user of previous.users ?? []) {
    try {
      await deleteUser(admin, user.id, 'previous seed')
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Previous E2E seed cleanup failed')
  await rm(statePath, { force: true })
}

const writeState = async ({ runId, league, users, password }) => {
  const state = {
    runId,
    leagueId: league.id,
    inviteCode: league.invite_code,
    password,
    users: users.map((user) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      teamName: user.teamName,
    })),
    createdAt: new Date().toISOString(),
  }
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

const createConfirmedUser = async (admin, user) => {
  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: {
      username: user.username,
      display_name: user.displayName,
    },
  })
  if (error) throw new Error(`createUser ${user.email}: ${error.message}`)
  if (!data.user) throw new Error(`createUser ${user.email}: no user returned`)
  return data.user
}

const signInClient = async (env, email, password) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return client
}

const seedLatencyFixtures = async (admin, leagueId, members) => {
  const { data: season, error: seasonError } = await admin
    .from('league_seasons')
    .select('id')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`latency fixture season: ${seasonError.message}`)

  const { error: matchupError } = await admin.from('matchups').insert({
    league_id: leagueId,
    league_season_id: season.id,
    week_number: 1,
    home_member_id: members[0].id,
    away_member_id: members[1].id,
    home_points: 0,
    away_points: 0,
  })
  if (matchupError) throw new Error(`latency fixture matchup: ${matchupError.message}`)

  const startedAt = new Date().toISOString()
  const { data: drafts, error: draftError } = await admin
    .from('drafts')
    .insert([
      {
        league_id: leagueId,
        league_season_id: season.id,
        draft_type: 'auction',
        status: 'in_progress',
        budget_per_team: 200,
        started_at: startedAt,
      },
      {
        league_id: leagueId,
        league_season_id: season.id,
        draft_type: 'snake',
        status: 'in_progress',
        started_at: startedAt,
      },
    ])
    .select('id, draft_type')
  if (draftError) throw new Error(`latency fixture drafts: ${draftError.message}`)

  const auctionDraft = drafts?.find((draft) => draft.draft_type === 'auction')
  const rookieDraft = drafts?.find((draft) => draft.draft_type === 'snake')
  if (!auctionDraft || !rookieDraft) throw new Error('latency fixture drafts were not returned')

  const orderRows = [auctionDraft, rookieDraft].flatMap((draft) => members.map((member, index) => ({
    draft_id: draft.id,
    member_id: member.id,
    position: index + 1,
  })))
  const budgetRows = members.map((member) => ({
    draft_id: auctionDraft.id,
    member_id: member.id,
    initial_budget: 200,
    remaining: 200,
  }))
  const pickRows = Array.from({ length: 3 }, (_, roundIndex) => {
    const round = roundIndex + 1
    const order = round % 2 === 0 ? [...members].reverse() : members
    return order.map((member, index) => ({
      draft_id: rookieDraft.id,
      overall_pick: roundIndex * members.length + index + 1,
      round,
      pick_in_round: index + 1,
      member_id: member.id,
    }))
  }).flat()
  const [{ error: orderError }, { error: budgetError }, { error: pickError }] = await Promise.all([
    admin.from('draft_orders').insert(orderRows),
    admin.from('draft_budgets').insert(budgetRows),
    admin.from('snake_draft_picks').insert(pickRows),
  ])
  if (orderError) throw new Error(`latency fixture draft orders: ${orderError.message}`)
  if (budgetError) throw new Error(`latency fixture draft budgets: ${budgetError.message}`)
  if (pickError) throw new Error(`latency fixture rookie picks: ${pickError.message}`)

  return { matchups: 1, drafts: drafts.length, draftOrders: orderRows.length, rookiePicks: pickRows.length }
}

const main = async () => {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey', 'anonKey'])

  const runId = process.env.E2E_SEED_RUN_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const password = `Pancake-e2e-${runId}!`
  const users = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1
    return {
      email: `pancake-e2e-${runId}-${n}@example.com`,
      password,
      username: `pancake_e2e_${runId}_${n}`,
      displayName: `Pancake E2E ${runId} #${n}`,
      teamName: `E2E Team ${n}`,
    }
  })

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const resources = createScenarioResourceOwner(`E2E seed ${runId}`)
  const resourceKeys = []
  const checks = []
  let league = null
  let previousSeedCleaned = false

  try {
    await cleanupPreviousSeed(admin)
    previousSeedCleaned = true
    const createdUsers = []
    for (const user of users) {
      const authUser = await createConfirmedUser(admin, user)
      const resourceKey = `user:${authUser.id}`
      resources.registerOnce(resourceKey, `seed user ${authUser.id}`, () => deleteUser(admin, authUser.id, 'failed seed'))
      resourceKeys.push(resourceKey)
      createdUsers.push({ ...user, id: authUser.id })
    }

    const profiles = createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    }))
    const { error: profileError } = await admin.from('profiles').upsert(profiles, { onConflict: 'id' })
    if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

    const playerFixtureCount = await seedPlayerFixtures(admin)
    checks.push({
      name: 'player_fixtures',
      status: playerFixtureCount >= 80 ? 'PASS' : 'FAIL',
      detail: `${playerFixtureCount} E2E players with 20 rookie draft numbers`,
    })

    const commissioner = await signInClient(env, users[0].email, password)
    const { data: createdLeague, error: createError } = await commissioner.rpc('create_league', {
      p_name: `Pancake E2E ${runId}`,
      p_team_name: users[0].teamName,
      p_auction_budget: 200,
    })
    if (createError) throw new Error(`create_league: ${createError.message}`)
    league = createdLeague
    const leagueResourceKey = `league:${league.id}`
    resources.registerOnce(leagueResourceKey, `seed league ${league.id}`, () => deleteLeague(admin, league.id, 'failed seed'))
    resourceKeys.push(leagueResourceKey)
    checks.push({
      name: 'invite_code',
      status: /^[A-Z0-9]{16}$/.test(league?.invite_code ?? '') ? 'PASS' : 'FAIL',
      detail: league?.invite_code ? '16-character code generated' : 'missing invite_code',
    })

    for (const user of users.slice(1)) {
      const client = await signInClient(env, user.email, password)
      const { error } = await client.rpc('join_league_by_invite_code', {
        p_invite_code: league.invite_code,
        p_team_name: user.teamName,
      })
      if (error) throw new Error(`join ${user.email}: ${error.message}`)
    }

    const { data: members, error: membersError } = await admin
      .from('league_members')
      .select('id, team_name')
      .eq('league_id', league.id)
    if (membersError) throw new Error(`members check: ${membersError.message}`)
    checks.push({
      name: 'league_members',
      status: members?.length === 10 ? 'PASS' : 'FAIL',
      detail: `${members?.length ?? 0} rows`,
    })

    const latencyFixtures = await seedLatencyFixtures(admin, league.id, members)
    checks.push({
      name: 'ranked_workflow_latency_fixtures',
      status: latencyFixtures.drafts === 2 && latencyFixtures.rookiePicks === 30 ? 'PASS' : 'FAIL',
      detail: `${latencyFixtures.matchups} matchup, ${latencyFixtures.drafts} drafts, ${latencyFixtures.draftOrders} orders, ${latencyFixtures.rookiePicks} rookie picks`,
    })

    const seasonYear = currentSeasonYear()
    const minPickYear = seasonYear + 1
    const maxPickYear = seasonYear + 5
    const { data: picks, error: picksError } = await admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id')
      .eq('league_id', league.id)
      .gte('season_year', minPickYear)
      .lte('season_year', maxPickYear)
    if (picksError) throw new Error(`draft_picks check: ${picksError.message}`)
    checks.push({
      name: 'future_pick_bank',
      status: picks?.length === 150 ? 'PASS' : 'FAIL',
      detail: `${picks?.length ?? 0} rows for ${minPickYear}-${maxPickYear}`,
    })

    const { data: slotRows, error: slotError } = await admin
      .from('lineup_slot_templates')
      .select('slot_type, slot_count')
      .eq('league_id', league.id)
    if (slotError) throw new Error(`lineup_slot_templates check: ${slotError.message}`)
    const actualSlots = new Map((slotRows ?? []).map((slot) => [slot.slot_type, slot.slot_count]))
    const slotFailures = Object.entries(EXPECTED_LINEUP_SLOTS).filter(([slot, count]) => actualSlots.get(slot) !== count)
    checks.push({
      name: 'lineup_slot_templates',
      status: slotFailures.length === 0 && slotRows?.length === Object.keys(EXPECTED_LINEUP_SLOTS).length
        ? 'PASS'
        : 'FAIL',
      detail: slotFailures.length === 0
        ? expectedSlotDetail()
        : `expected ${expectedSlotDetail()}; got ${JSON.stringify(Object.fromEntries(actualSlots))}`,
    })

    const failures = checks.filter((check) => check.status !== 'PASS')
    if (failures.length > 0) throw new Error(`Seed validation failed: ${failures.map((failure) => failure.name).join(', ')}`)
    await writeState({ runId, league, users: createdUsers, password })
    await writeReport({ runId, league, users: createdUsers, checks })
    for (const resourceKey of resourceKeys) resources.release(resourceKey)
  } catch (error) {
    checks.push({ name: 'seed', status: 'ERROR', detail: errorText(error) })
    let cleanupError = null
    try {
      await resources.dispose()
    } catch (resourceError) {
      cleanupError = resourceError
    }
    if (previousSeedCleaned) await rm(STATE_PATH, { force: true })
    await writeReport({ runId, league, users, checks, cleanupError: cleanupError ? errorText(cleanupError) : null })
    if (cleanupError) throw new AggregateError([error, cleanupError], 'E2E seed and rollback failed')
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
