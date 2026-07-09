import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { cleanMessage, describeEndpoint } from './env.mjs'
import { createFixtureResourceOwner } from './trade-fixture.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-dynasty-release-final-gate-report.md')
export const ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/dynasty-release-final-gate')
const E2E_PLAYER_PREFIX = 'e2e-player-'

const positions = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
const teams = ['ATL', 'BOS', 'CHI', 'DAL', 'DEN', 'GSW', 'LAL', 'MIA']

export const rows = []

export function todayET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

export function tomorrowIso() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}

export function pastIso() {
  return new Date(Date.now() - 5 * 60 * 1000).toISOString()
}

function futureIso() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString()
}

function safeCell(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\n', '<br>')
}

export function record(area, check, status, evidence) {
  rows.push({ area, check, status, evidence })
}

export async function step(area, check, fn) {
  try {
    const evidence = await fn()
    record(area, check, 'PASS', evidence ?? 'ok')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(area, check, 'FAIL', cleanMessage(message, { maxLines: 8 }) || message)
    throw error
  }
}

export async function writeReport(context = {}) {
  const failures = rows.filter((row) => row.status !== 'PASS')
  const lines = [
    '# Dynasty Release Final Gate',
    '',
    `- Status: ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Supabase: ${describeEndpoint(context.supabaseUrl)}`,
    `- API: ${describeEndpoint(context.apiBaseUrl)}`,
    `- League ID: ${context.leagueId ?? '<not-created>'}`,
    `- Run ID: ${context.runId ?? '<not-created>'}`,
    '',
    '| Area | Check | Status | Evidence |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${safeCell(row.area)} | ${safeCell(row.check)} | ${safeCell(row.status)} | ${safeCell(row.evidence)} |`),
    '',
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}`)
}

export function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

export async function expectError(label, fn, expectedText) {
  try {
    await fn()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes(expectedText.toLowerCase())) {
      throw new Error(`${label}: expected error containing "${expectedText}", got "${message}"`)
    }
    return message
  }
  throw new Error(`${label}: expected an error containing "${expectedText}"`)
}

export function createSupabaseClient(url, key) {
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

async function createConfirmedUser(admin, user) {
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
  return { ...user, id: data.user.id }
}

async function signIn(env, email, password) {
  const client = createSupabaseClient(env.supabaseUrl, env.anonKey)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  const token = data.session?.access_token
  if (!token) throw new Error(`signIn ${email}: no access token returned`)
  return { client, token }
}

export async function apiPost(env, token, route, body) {
  const res = await fetch(`${env.apiBaseUrl}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || json?.ok === false) {
    const message = json?.message ?? json?.error ?? `HTTP ${res.status}`
    throw new Error(`${route}: ${message}`)
  }
  return json
}

async function seedPlayerFixtures(admin) {
  const players = Array.from({ length: 100 }, (_, index) => {
    const n = index + 1
    const position = positions[index % positions.length]
    return {
      sportsdata_id: `${E2E_PLAYER_PREFIX}${String(n).padStart(3, '0')}`,
      nba_id: `E2ENBA${String(n).padStart(3, '0')}`,
      sleeper_id: `e2e-sleeper-${String(n).padStart(3, '0')}`,
      first_name: 'E2E',
      last_name: `Player${String(n).padStart(3, '0')}`,
      nba_team: teams[index % teams.length],
      position,
      eligible_positions: [position],
      status: 'Active',
      injury_status: null,
      years_exp: index < 24 ? 0 : 3,
      nba_draft_number: index < 24 ? n : null,
    }
  })

  const { error } = await admin
    .from('players')
    .upsert(players, { onConflict: 'sportsdata_id' })
  if (error) throw new Error(`players fixture upsert: ${error.message}`)

  const { data, error: selectError } = await admin
    .from('players')
    .select('id, display_name, sportsdata_id')
    .like('sportsdata_id', `${E2E_PLAYER_PREFIX}%`)
    .order('sportsdata_id', { ascending: true })
  if (selectError) throw new Error(`players fixture select: ${selectError.message}`)
  if ((data ?? []).length < 32) throw new Error(`players fixture count ${(data ?? []).length}; expected at least 32`)
  return data
}

async function fetchCurrentSeason(admin, leagueId) {
  const { data, error } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  if (error) throw new Error(`current season lookup: ${error.message}`)
  return data
}

async function fetchMembers(admin, leagueId) {
  const { data, error } = await admin
    .from('league_members')
    .select('id, user_id, role, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league members lookup: ${error.message}`)
  return data ?? []
}

async function ensureWaiverPriority(admin, leagueId, seasonId, members) {
  const rows = members.map((member, index) => ({
    league_id: leagueId,
    league_season_id: seasonId,
    member_id: member.id,
    priority: index + 1,
  }))
  const { error } = await admin
    .from('waiver_priorities')
    .upsert(rows, { onConflict: 'league_id,league_season_id,member_id' })
  if (error) throw new Error(`waiver priority upsert: ${error.message}`)
}

async function ensureFaabBalances(admin, leagueId, seasonId, members, balance = 100) {
  const rows = members.map((member) => ({
    league_id: leagueId,
    league_season_id: seasonId,
    member_id: member.id,
    balance,
  }))
  const { error } = await admin
    .from('faab_balances')
    .upsert(rows, { onConflict: 'league_id,league_season_id,member_id' })
  if (error) throw new Error(`faab balance upsert: ${error.message}`)
}

export async function createWaiverLog(admin, leagueId, seasonId, playerId, clearsAt = futureIso()) {
  const { data, error } = await admin
    .from('waiver_wire_log')
    .insert({
      league_id: leagueId,
      league_season_id: seasonId,
      player_id: playerId,
      dropped_by_member_id: null,
      clears_at: clearsAt,
    })
    .select('id')
    .single()
  if (error) throw new Error(`waiver log insert: ${error.message}`)
  return data.id
}

export async function findClaim(admin, memberId, playerId) {
  const { data, error } = await admin
    .from('waiver_claims')
    .select('id, status, bid_amount, claim_order, failure_reason')
    .eq('member_id', memberId)
    .eq('player_id', playerId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`waiver claim lookup: ${error.message}`)
  if (!data) throw new Error(`waiver claim not found for member=${memberId} player=${playerId}`)
  return data
}

export async function makeClaimDue(admin, claimId, waiverLogId) {
  const [{ error: claimError }, { error: logError }] = await Promise.all([
    admin
      .from('waiver_claims')
      .update({ process_date: todayET() })
      .eq('id', claimId),
    admin
      .from('waiver_wire_log')
      .update({ clears_at: pastIso(), cleared_at: null })
      .eq('id', waiverLogId),
  ])
  if (claimError) throw new Error(`claim due update: ${claimError.message}`)
  if (logError) throw new Error(`waiver log due update: ${logError.message}`)
}

export async function processWaiversUntil(admin, claimIds) {
  const pending = new Set(claimIds)
  for (let attempt = 0; attempt < 10 && pending.size > 0; attempt += 1) {
    const { error } = await admin.rpc('process_due_waiver_claims_atomic', {
      p_process_date: todayET(),
      p_limit: 50,
    })
    if (error) throw new Error(`process_due_waiver_claims_atomic: ${error.message}`)

    const { data, error: selectError } = await admin
      .from('waiver_claims')
      .select('id, status')
      .in('id', [...pending])
    if (selectError) throw new Error(`waiver status poll: ${selectError.message}`)
    for (const row of data ?? []) {
      if (row.status !== 'pending') pending.delete(row.id)
    }
  }
  if (pending.size > 0) throw new Error(`waiver claims stayed pending: ${[...pending].join(', ')}`)
}

export async function getBalance(admin, leagueId, seasonId, memberId) {
  const { data, error } = await admin
    .from('faab_balances')
    .select('balance')
    .eq('league_id', leagueId)
    .eq('league_season_id', seasonId)
    .eq('member_id', memberId)
    .single()
  if (error) throw new Error(`faab balance lookup: ${error.message}`)
  return Number(data.balance)
}

export async function getWeeklyAddCount(admin, leagueId, seasonId, memberId) {
  const { data, error } = await admin
    .from('weekly_add_counts')
    .select('add_count')
    .eq('league_id', leagueId)
    .eq('league_season_id', seasonId)
    .eq('member_id', memberId)
    .maybeSingle()
  if (error) throw new Error(`weekly add count lookup: ${error.message}`)
  return Number(data?.add_count ?? 0)
}

export async function rosterHas(admin, leagueId, seasonId, memberId, playerId) {
  const { data, error } = await admin
    .from('roster_players')
    .select('id')
    .eq('league_id', leagueId)
    .eq('league_season_id', seasonId)
    .eq('member_id', memberId)
    .eq('player_id', playerId)
    .maybeSingle()
  if (error) throw new Error(`roster lookup: ${error.message}`)
  return data?.id ?? null
}

export async function fetchTrade(admin, tradeId) {
  const { data, error } = await admin
    .from('trades')
    .select('id, status, proposer_member_id, recipient_member_id, parent_trade_id, countered_from_trade_id, edited_from_trade_id, replaced_by_trade_id, version, proposer_faab_amount, recipient_faab_amount, expires_at')
    .eq('id', tradeId)
    .single()
  if (error) throw new Error(`trade lookup ${tradeId}: ${error.message}`)
  return data
}

export async function setupFixture(env, admin) {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`
  const password = `Pancake-release-${runId}!`
  const baseUsers = ['Commissioner', 'Manager Two', 'Manager Three', 'Manager Four'].map((label, index) => ({
    email: `pancake-release-${runId}-${index + 1}@example.com`,
    password,
    username: `pancake_release_${runId}_${index + 1}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Release ${label} ${runId}`,
    teamName: label,
  }))

  const resources = createFixtureResourceOwner(admin)
  try {
  const users = []
  for (const user of baseUsers) {
    const createdUser = await createConfirmedUser(admin, user)
    users.push(createdUser)
    resources.registerUser(createdUser.id)
  }
  const { error: profileError } = await admin.from('profiles').upsert(
    users.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    })),
    { onConflict: 'id' },
  )
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const sessions = []
  for (const user of users) sessions.push(await signIn(env, user.email, password))

  const { data: league, error: createError } = await sessions[0].client.rpc('create_league', {
    p_name: `Pancake Release Gate ${runId}`,
    p_team_name: users[0].teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)
  resources.registerLeague(league.id)

  const { error: settingsError } = await sessions[0].client.rpc('update_league_settings_atomic', {
    p_league_id: league.id,
    p_settings: {
      roster_size: 8,
      weekly_add_limit: 1,
      waiver_mode: 'faab',
      faab_starting_budget: 100,
    },
  })
  if (settingsError) throw new Error(`initial settings update: ${settingsError.message}`)

  for (const [index, session] of sessions.slice(1).entries()) {
    const { error } = await session.client.rpc('join_league_by_invite_code', {
      p_invite_code: league.invite_code,
      p_team_name: users[index + 1].teamName,
    })
    if (error) throw new Error(`join_league_by_invite_code ${users[index + 1].email}: ${error.message}`)
  }

  const { error: activeError } = await admin
    .from('leagues')
    .update({ status: 'active' })
    .eq('id', league.id)
  if (activeError) throw new Error(`league activation: ${activeError.message}`)

  const season = await fetchCurrentSeason(admin, league.id)
  const members = await fetchMembers(admin, league.id)
  if (members.length !== 4) throw new Error(`expected 4 league members, got ${members.length}`)
  await ensureWaiverPriority(admin, league.id, season.id, members)
  await ensureFaabBalances(admin, league.id, season.id, members)

  const players = await seedPlayerFixtures(admin)
  return {
    runId,
    password,
    users,
    sessions,
    league,
    season,
    members: members.map((member) => ({
      ...member,
      session: sessions.find((_, index) => users[index].id === member.user_id),
      user: users.find((user) => user.id === member.user_id),
    })),
    players,
    dispose: async () => {
      await Promise.all(sessions.map((session) => session.client.auth.signOut()))
      await resources.dispose()
    },
  }
  } catch (error) {
    await resources.dispose().catch(() => {})
    throw error
  }
}
