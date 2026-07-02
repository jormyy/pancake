import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { cleanMessage, describeEndpoint, requireEnv, resolvedEnv } from './env.mjs'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-dynasty-release-final-gate-report.md')
const ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/dynasty-release-final-gate')
const E2E_PLAYER_PREFIX = 'e2e-player-'

const positions = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
const teams = ['ATL', 'BOS', 'CHI', 'DAL', 'DEN', 'GSW', 'LAL', 'MIA']

const rows = []

function todayET(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

function tomorrowIso() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
}

function pastIso() {
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

function record(area, check, status, evidence) {
  rows.push({ area, check, status, evidence })
}

async function step(area, check, fn) {
  try {
    const evidence = await fn()
    record(area, check, 'PASS', evidence ?? 'ok')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    record(area, check, 'FAIL', cleanMessage(message, { maxLines: 8 }) || message)
    throw error
  }
}

async function writeReport(context = {}) {
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

function assertCondition(condition, message) {
  if (!condition) throw new Error(message)
}

async function expectError(label, fn, expectedText) {
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

function createSupabaseClient(url, key) {
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

async function apiPost(env, token, route, body) {
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

async function createWaiverLog(admin, leagueId, seasonId, playerId, clearsAt = futureIso()) {
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

async function findClaim(admin, memberId, playerId) {
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

async function makeClaimDue(admin, claimId, waiverLogId) {
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

async function processWaiversUntil(admin, claimIds) {
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

async function getBalance(admin, leagueId, seasonId, memberId) {
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

async function getWeeklyAddCount(admin, leagueId, seasonId, memberId) {
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

async function rosterHas(admin, leagueId, seasonId, memberId, playerId) {
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

async function fetchTrade(admin, tradeId) {
  const { data, error } = await admin
    .from('trades')
    .select('id, status, proposer_member_id, recipient_member_id, parent_trade_id, countered_from_trade_id, edited_from_trade_id, replaced_by_trade_id, version, proposer_faab_amount, recipient_faab_amount, expires_at')
    .eq('id', tradeId)
    .single()
  if (error) throw new Error(`trade lookup ${tradeId}: ${error.message}`)
  return data
}

async function setupFixture(env, admin) {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`
  const password = `Pancake-release-${runId}!`
  const baseUsers = ['Commissioner', 'Manager Two', 'Manager Three', 'Manager Four'].map((label, index) => ({
    email: `pancake-release-${runId}-${index + 1}@example.com`,
    password,
    username: `pancake_release_${runId}_${index + 1}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Release ${label} ${runId}`,
    teamName: label,
  }))

  const users = []
  for (const user of baseUsers) users.push(await createConfirmedUser(admin, user))
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
  }
}

async function main() {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey', 'apiBaseUrl'])
  const admin = createSupabaseClient(env.supabaseUrl, env.serviceRoleKey)
  const context = { supabaseUrl: env.supabaseUrl, apiBaseUrl: env.apiBaseUrl }
  await mkdir(ARTIFACT_DIR, { recursive: true })

  try {
    const health = await fetch(`${env.apiBaseUrl}/health`).then((res) => res.json())
    assertCondition(health?.ok === true, 'Edge API health check did not return ok=true')
    record('environment', 'edge api health', 'PASS', 'GET /health returned ok=true')

    let fixture
    await step('fixtures', 'isolated league, users, seeded players', async () => {
      fixture = await setupFixture(env, admin)
      context.runId = fixture.runId
      context.leagueId = fixture.league.id
      return `league=${fixture.league.id}; users=${fixture.users.length}; players=${fixture.players.length}`
    })

    const [commissioner, managerTwo, managerThree, managerFour] = fixture.members
    const [
      freeAddPlayer,
      blockedFreeAddPlayer,
      managerTwoRosterPlayer,
      dropAddTargetPlayer,
      waiverLimitPlayer,
      cancelClaimPlayer,
      editClaimPlayer,
      highBidPlayer,
      tieBidPlayer,
      expiredTradePlayer,
      reservedEditClaimPlayer,
    ] = fixture.players

    await step('commissioner settings', 'weekly add limit, FAAB mode, budget, and state RPC', async () => {
      const { data: leagueRow, error: leagueError } = await admin
        .from('leagues')
        .select('weekly_add_limit, waiver_mode, faab_starting_budget, roster_size')
        .eq('id', fixture.league.id)
        .single()
      if (leagueError) throw new Error(`league settings lookup: ${leagueError.message}`)
      assertCondition(leagueRow.weekly_add_limit === 1, `weekly_add_limit=${leagueRow.weekly_add_limit}`)
      assertCondition(leagueRow.waiver_mode === 'faab', `waiver_mode=${leagueRow.waiver_mode}`)
      assertCondition(leagueRow.faab_starting_budget === 100, `faab_starting_budget=${leagueRow.faab_starting_budget}`)
      const { data: state, error: stateError } = await commissioner.session.client.rpc('get_member_transaction_state', {
        p_member_id: commissioner.id,
        p_league_id: fixture.league.id,
      })
      if (stateError) throw new Error(`get_member_transaction_state: ${stateError.message}`)
      const row = state?.[0]
      assertCondition(row?.weekly_add_limit === 1, `state weekly_add_limit=${row?.weekly_add_limit}`)
      assertCondition(row?.faab_balance === 100, `state faab_balance=${row?.faab_balance}`)
      return 'commissioner-authenticated settings and transaction state reflect weekly_add_limit=1, waiver_mode=faab, FAAB=$100'
    })

    await step('weekly add limits', 'free-agent add consumes count and second add is blocked', async () => {
      const { error: addError } = await commissioner.session.client.rpc('add_free_agent_atomic', {
        p_member_id: commissioner.id,
        p_league_id: fixture.league.id,
        p_player_id: freeAddPlayer.id,
      })
      if (addError) throw new Error(`first add_free_agent_atomic: ${addError.message}`)
      const message = await expectError(
        'second add_free_agent_atomic',
        () => commissioner.session.client.rpc('add_free_agent_atomic', {
          p_member_id: commissioner.id,
          p_league_id: fixture.league.id,
          p_player_id: blockedFreeAddPlayer.id,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'Weekly add limit reached',
      )
      const count = await getWeeklyAddCount(admin, fixture.league.id, fixture.season.id, commissioner.id)
      const blockedRosterId = await rosterHas(admin, fixture.league.id, fixture.season.id, commissioner.id, blockedFreeAddPlayer.id)
      assertCondition(count === 1, `weekly add count=${count}; expected 1`)
      assertCondition(blockedRosterId === null, 'blocked player was rostered')
      return `first add succeeded, second add failed with "${message}", count=${count}`
    })

    await step('weekly add limits', 'waiver processing and drop-add enforce the limit', async () => {
      const { data: rosterSeed, error: rosterSeedError } = await admin
        .from('roster_players')
        .insert({
          member_id: managerTwo.id,
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          player_id: managerTwoRosterPlayer.id,
          acquired_via: 'e2e_release_gate',
        })
        .select('id')
        .single()
      if (rosterSeedError) throw new Error(`manager two roster seed: ${rosterSeedError.message}`)

      const waiverLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, waiverLimitPlayer.id)
      await apiPost(env, managerTwo.session.token, '/waivers/claims', {
        memberId: managerTwo.id,
        leagueId: fixture.league.id,
        playerId: waiverLimitPlayer.id,
        bidAmount: 4,
      })
      const claim = await findClaim(admin, managerTwo.id, waiverLimitPlayer.id)

      const { data: overrideCount, error: overrideError } = await commissioner.session.client.rpc('commissioner_override_weekly_add_count_atomic', {
        p_league_id: fixture.league.id,
        p_member_id: managerTwo.id,
        p_add_count: 1,
      })
      if (overrideError) throw new Error(`commissioner_override_weekly_add_count_atomic: ${overrideError.message}`)
      assertCondition(Number(overrideCount) === 1, `override returned ${overrideCount}`)

      await makeClaimDue(admin, claim.id, waiverLogId)
      await processWaiversUntil(admin, [claim.id])
      const processedClaim = await findClaim(admin, managerTwo.id, waiverLimitPlayer.id)
      assertCondition(processedClaim.status === 'failed_roster', `claim status=${processedClaim.status}`)
      assertCondition(
        String(processedClaim.failure_reason ?? '').includes('Weekly add limit reached'),
        `claim failure_reason=${processedClaim.failure_reason}`,
      )

      const dropAddMessage = await expectError(
        'drop_and_add_free_agent_atomic',
        () => managerTwo.session.client.rpc('drop_and_add_free_agent_atomic', {
          p_roster_player_id: rosterSeed.id,
          p_member_id: managerTwo.id,
          p_league_id: fixture.league.id,
          p_player_id: dropAddTargetPlayer.id,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'Weekly add limit reached',
      )
      const stillHasDropPlayer = await rosterHas(admin, fixture.league.id, fixture.season.id, managerTwo.id, managerTwoRosterPlayer.id)
      const hasAddTarget = await rosterHas(admin, fixture.league.id, fixture.season.id, managerTwo.id, dropAddTargetPlayer.id)
      assertCondition(stillHasDropPlayer !== null, 'drop-add removed the original roster player despite failure')
      assertCondition(hasAddTarget === null, 'drop-add added the target despite failure')
      return `waiver claim failed at processing; drop-add failed with "${dropAddMessage}"`
    })

    await step('waiver claims', 'pending claim submit, edit, reorder, and cancel', async () => {
      const logA = await createWaiverLog(admin, fixture.league.id, fixture.season.id, cancelClaimPlayer.id)
      const logB = await createWaiverLog(admin, fixture.league.id, fixture.season.id, editClaimPlayer.id)
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: cancelClaimPlayer.id,
        bidAmount: 5,
        claimOrder: 1,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: editClaimPlayer.id,
        bidAmount: 5,
        claimOrder: 2,
      })
      const cancelClaim = await findClaim(admin, managerFour.id, cancelClaimPlayer.id)
      const editClaim = await findClaim(admin, managerFour.id, editClaimPlayer.id)
      const reorderResult = await apiPost(env, managerFour.session.token, `/waivers/claims/${editClaim.id}/reorder`, {
        memberId: managerFour.id,
        direction: 'up',
      })
      assertCondition(Number(reorderResult.claimOrder) === 1, `reorder claimOrder=${reorderResult.claimOrder}`)
      await apiPost(env, managerFour.session.token, `/waivers/claims/${editClaim.id}/edit`, {
        memberId: managerFour.id,
        bidAmount: 7,
        claimOrder: 1,
      })
      await apiPost(env, managerFour.session.token, `/waivers/claims/${cancelClaim.id}/cancel`, {
        memberId: managerFour.id,
      })

      const edited = await findClaim(admin, managerFour.id, editClaimPlayer.id)
      const canceled = await findClaim(admin, managerFour.id, cancelClaimPlayer.id)
      assertCondition(edited.status === 'pending', `edited status=${edited.status}`)
      assertCondition(edited.bid_amount === 7, `edited bid=${edited.bid_amount}`)
      assertCondition(edited.claim_order === 1, `edited claim_order=${edited.claim_order}`)
      assertCondition(canceled.status === 'cancelled', `canceled status=${canceled.status}`)

      await writeFile(path.join(ARTIFACT_DIR, 'pending-claims.json'), `${JSON.stringify({ logA, logB, edited, canceled }, null, 2)}\n`)
      return `edited claim ${editClaim.id} to bid=$7/order=1 and canceled claim ${cancelClaim.id}`
    })

    await step('faab waivers', 'blind bids, budget checks, processing, and bid tiebreaker', async () => {
      const { error: limitError } = await commissioner.session.client.rpc('update_league_settings_atomic', {
        p_league_id: fixture.league.id,
        p_settings: { weekly_add_limit: 3 },
      })
      if (limitError) throw new Error(`weekly limit raise: ${limitError.message}`)

      const highBidLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, highBidPlayer.id)
      await apiPost(env, managerThree.session.token, '/waivers/claims', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        playerId: highBidPlayer.id,
        bidAmount: 30,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: highBidPlayer.id,
        bidAmount: 20,
      })
      const highBidWinner = await findClaim(admin, managerThree.id, highBidPlayer.id)
      const highBidLoser = await findClaim(admin, managerFour.id, highBidPlayer.id)
      await makeClaimDue(admin, highBidWinner.id, highBidLogId)
      const { error: highBidLoserDueError } = await admin
        .from('waiver_claims')
        .update({ process_date: todayET() })
        .eq('id', highBidLoser.id)
      if (highBidLoserDueError) throw new Error(`high-bid loser due update: ${highBidLoserDueError.message}`)
      await processWaiversUntil(admin, [highBidWinner.id, highBidLoser.id])

      const tieLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, tieBidPlayer.id)
      await apiPost(env, managerThree.session.token, '/waivers/claims', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        bidAmount: 11,
      })
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        bidAmount: 11,
      })
      const tieLoser = await findClaim(admin, managerThree.id, tieBidPlayer.id)
      const tieWinner = await findClaim(admin, managerFour.id, tieBidPlayer.id)
      await makeClaimDue(admin, tieWinner.id, tieLogId)
      const { error: tieLoserDueError } = await admin
        .from('waiver_claims')
        .update({ process_date: todayET() })
        .eq('id', tieLoser.id)
      if (tieLoserDueError) throw new Error(`tie loser due update: ${tieLoserDueError.message}`)
      await processWaiversUntil(admin, [tieWinner.id, tieLoser.id])

      const highWinnerRow = await findClaim(admin, managerThree.id, highBidPlayer.id)
      const highLoserRow = await findClaim(admin, managerFour.id, highBidPlayer.id)
      const tieWinnerRow = await findClaim(admin, managerFour.id, tieBidPlayer.id)
      const tieLoserRow = await findClaim(admin, managerThree.id, tieBidPlayer.id)
      assertCondition(highWinnerRow.status === 'succeeded', `high bid winner status=${highWinnerRow.status}`)
      assertCondition(highLoserRow.status === 'failed_priority', `high bid loser status=${highLoserRow.status}`)
      assertCondition(tieWinnerRow.status === 'succeeded', `tie winner status=${tieWinnerRow.status}`)
      assertCondition(tieLoserRow.status === 'failed_priority', `tie loser status=${tieLoserRow.status}`)
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, highBidPlayer.id), 'high bid winner did not roster player')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerFour.id, tieBidPlayer.id), 'tie winner did not roster player')
      const managerThreeBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id)
      const managerFourBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerFour.id)
      assertCondition(managerThreeBalance === 70, `managerThree FAAB=${managerThreeBalance}; expected 70`)
      assertCondition(managerFourBalance === 89, `managerFour FAAB=${managerFourBalance}; expected 89`)
      return 'bid $30 beat $20; equal $11 bids used waiver-priority tiebreaker; balances are $70 and $89'
    })

    await step('commissioner controls', 'FAAB balance adjustment and weekly count override', async () => {
      const { data: adjusted, error: adjustError } = await commissioner.session.client.rpc('commissioner_adjust_faab_balance_atomic', {
        p_league_id: fixture.league.id,
        p_member_id: managerTwo.id,
        p_balance: 42,
      })
      if (adjustError) throw new Error(`commissioner_adjust_faab_balance_atomic: ${adjustError.message}`)
      assertCondition(Number(adjusted) === 42, `adjusted balance=${adjusted}`)
      const { data: state, error: stateError } = await managerTwo.session.client.rpc('get_member_transaction_state', {
        p_member_id: managerTwo.id,
        p_league_id: fixture.league.id,
      })
      if (stateError) throw new Error(`manager two transaction state: ${stateError.message}`)
      assertCondition(state?.[0]?.faab_balance === 42, `state FAAB=${state?.[0]?.faab_balance}`)
      assertCondition(state?.[0]?.weekly_add_count === 1, `state weekly_add_count=${state?.[0]?.weekly_add_count}`)
      return 'commissioner set Manager Two FAAB to $42 and weekly_add_count remains overridden at 1'
    })

    await step('trade negotiation', 'counteroffers, outgoing edits, and expired edit rejection', async () => {
      const proposed = await apiPost(env, commissioner.session.token, '/trades/propose', {
        memberId: commissioner.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 5,
        requestFaabAmount: 1,
        notes: 'release gate original',
      })
      const countered = await apiPost(env, managerTwo.session.token, `/trades/${proposed.tradeId}/counter`, {
        memberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 2,
        requestFaabAmount: 4,
        notes: 'release gate counter',
      })
      const edited = await apiPost(env, managerTwo.session.token, `/trades/${countered.tradeId}/edit`, {
        memberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 3,
        requestFaabAmount: 4,
        notes: 'release gate edited counter',
      })

      const original = await fetchTrade(admin, proposed.tradeId)
      const counter = await fetchTrade(admin, countered.tradeId)
      const edit = await fetchTrade(admin, edited.tradeId)
      assertCondition(original.status === 'countered', `original status=${original.status}`)
      assertCondition(counter.status === 'edited', `counter status=${counter.status}`)
      assertCondition(edit.status === 'pending', `edit status=${edit.status}`)
      assertCondition(counter.countered_from_trade_id === original.id, 'counter missing countered_from_trade_id')
      assertCondition(edit.edited_from_trade_id === counter.id, 'edit missing edited_from_trade_id')
      assertCondition(edit.version === 3, `edited version=${edit.version}`)
      assertCondition(edit.proposer_faab_amount === 3 && edit.recipient_faab_amount === 4, `edited FAAB=${edit.proposer_faab_amount}/${edit.recipient_faab_amount}`)

      const expiring = await apiPost(env, commissioner.session.token, '/trades/propose', {
        memberId: commissioner.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerTwo.id,
        offerPlayerIds: [],
        requestPlayerIds: [],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 1,
        requestFaabAmount: 1,
        expiresAt: tomorrowIso(),
        notes: 'release gate expired edit',
      })
      const { error: expireUpdateError } = await admin
        .from('trades')
        .update({ expires_at: pastIso() })
        .eq('id', expiring.tradeId)
      if (expireUpdateError) throw new Error(`expire trade update: ${expireUpdateError.message}`)
      const expiredMessage = await expectError(
        'expired trade edit',
        () => apiPost(env, commissioner.session.token, `/trades/${expiring.tradeId}/edit`, {
          memberId: commissioner.id,
          offerPlayerIds: [],
          requestPlayerIds: [],
          offerPickIds: [],
          requestPickIds: [],
          offerFaabAmount: 2,
          requestFaabAmount: 1,
        }),
        'expired',
      )
      const expired = await fetchTrade(admin, expiring.tradeId)
      assertCondition(expired.status === 'expired', `expired trade status=${expired.status}`)

      const { error: expiredRosterSeedError } = await admin
        .from('roster_players')
        .insert({
          member_id: commissioner.id,
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          player_id: expiredTradePlayer.id,
          acquired_via: 'e2e_release_gate',
        })
      if (expiredRosterSeedError) throw new Error(`expired trade roster seed: ${expiredRosterSeedError.message}`)
      return `counter/edit chain reached version 3; expired edit rejected with "${expiredMessage}"`
    })

    await step('trade block and faab trading', 'Make Offer path creates and completes FAAB trade from a block item', async () => {
      const block = await apiPost(env, managerFour.session.token, '/trades/block', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: tieBidPlayer.id,
        note: 'release gate available for offers',
      })
      const { data: blockRow, error: blockError } = await admin
        .from('trade_block_items')
        .select('id, member_id, player_id, note')
        .eq('id', block.tradeBlockItemId)
        .single()
      if (blockError) throw new Error(`trade block lookup: ${blockError.message}`)
      assertCondition(blockRow.player_id === tieBidPlayer.id, `block player=${blockRow.player_id}`)

      const makeOffer = await apiPost(env, managerThree.session.token, '/trades/propose', {
        memberId: managerThree.id,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.season.id,
        recipientMemberId: managerFour.id,
        offerPlayerIds: [highBidPlayer.id],
        requestPlayerIds: [tieBidPlayer.id],
        offerPickIds: [],
        requestPickIds: [],
        offerFaabAmount: 10,
        requestFaabAmount: 0,
        notes: 'release gate make offer from trade block',
      })
      await apiPost(env, managerFour.session.token, `/trades/${makeOffer.tradeId}/accept`, {
        memberId: managerFour.id,
        dropRosterPlayerIds: [],
      })

      const reservedEditLogId = await createWaiverLog(admin, fixture.league.id, fixture.season.id, reservedEditClaimPlayer.id)
      await apiPost(env, managerFour.session.token, '/waivers/claims', {
        memberId: managerFour.id,
        leagueId: fixture.league.id,
        playerId: reservedEditClaimPlayer.id,
        bidAmount: 1,
        claimOrder: 3,
      })
      const reservedEditClaim = await findClaim(admin, managerFour.id, reservedEditClaimPlayer.id)
      const reservedEditMessage = await expectError(
        'reserved trade drop edit_waiver_claim_atomic',
        () => apiPost(env, managerFour.session.token, `/waivers/claims/${reservedEditClaim.id}/edit`, {
          memberId: managerFour.id,
          dropPlayerId: tieBidPlayer.id,
          bidAmount: 1,
          claimOrder: reservedEditClaim.claim_order,
        }),
        'reserved',
      )

      const { error: windowError } = await admin
        .from('trades')
        .update({ veto_window_expires_at: pastIso() })
        .eq('id', makeOffer.tradeId)
      if (windowError) throw new Error(`veto window update: ${windowError.message}`)
      const { error: processError } = await admin.rpc('process_due_accepted_trades_atomic', { p_limit: 20 })
      if (processError) throw new Error(`process_due_accepted_trades_atomic: ${processError.message}`)

      const completed = await fetchTrade(admin, makeOffer.tradeId)
      assertCondition(completed.status === 'completed', `trade status=${completed.status}`)
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerFour.id, highBidPlayer.id), 'offered player did not move to trade-block owner')
      assertCondition(await rosterHas(admin, fixture.league.id, fixture.season.id, managerThree.id, tieBidPlayer.id), 'requested trade-block player did not move to offer maker')
      const { data: blockAfterTrade, error: blockAfterTradeError } = await admin
        .from('trade_block_items')
        .select('id')
        .eq('id', block.tradeBlockItemId)
        .maybeSingle()
      if (blockAfterTradeError) throw new Error(`trade block post-completion lookup: ${blockAfterTradeError.message}`)
      assertCondition(blockAfterTrade === null, 'trade block player listing survived completed trade')
      const managerThreeBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerThree.id)
      const managerFourBalance = await getBalance(admin, fixture.league.id, fixture.season.id, managerFour.id)
      assertCondition(managerThreeBalance === 60, `managerThree balance after trade=${managerThreeBalance}; expected 60`)
      assertCondition(managerFourBalance === 99, `managerFour balance after trade=${managerFourBalance}; expected 99`)
      return `block item ${block.tradeBlockItemId} produced trade ${makeOffer.tradeId}; reserved drop edit rejected with "${reservedEditMessage}"; claim log ${reservedEditLogId}`
    })

    await step('notification preferences', 'authenticated user can persist own preference toggles only', async () => {
      const { error: upsertError } = await managerThree.session.client
        .from('notification_preferences')
        .upsert({
          user_id: managerThree.user.id,
          trade_enabled: false,
          waiver_enabled: true,
          draft_enabled: false,
          activity_enabled: true,
        }, { onConflict: 'user_id' })
      if (upsertError) throw new Error(`notification preference upsert: ${upsertError.message}`)

      const { data, error: selectError } = await managerThree.session.client
        .from('notification_preferences')
        .select('trade_enabled, waiver_enabled, draft_enabled, activity_enabled')
        .eq('user_id', managerThree.user.id)
        .single()
      if (selectError) throw new Error(`notification preference select: ${selectError.message}`)
      assertCondition(data.trade_enabled === false, `trade_enabled=${data.trade_enabled}`)
      assertCondition(data.waiver_enabled === true, `waiver_enabled=${data.waiver_enabled}`)
      assertCondition(data.draft_enabled === false, `draft_enabled=${data.draft_enabled}`)
      assertCondition(data.activity_enabled === true, `activity_enabled=${data.activity_enabled}`)

      const { data: crossUserRows, error: crossUserError } = await managerTwo.session.client
        .from('notification_preferences')
        .update({ trade_enabled: true })
        .eq('user_id', managerThree.user.id)
        .select('user_id')
      if (crossUserError) throw new Error(`cross-user notification preference update: ${crossUserError.message}`)
      assertCondition((crossUserRows ?? []).length === 0, 'cross-user notification preference update returned rows')
      const { data: afterCrossUser, error: afterCrossUserError } = await admin
        .from('notification_preferences')
        .select('trade_enabled')
        .eq('user_id', managerThree.user.id)
        .single()
      if (afterCrossUserError) throw new Error(`cross-user notification preference verify: ${afterCrossUserError.message}`)
      assertCondition(afterCrossUser.trade_enabled === false, `cross-user update changed trade_enabled=${afterCrossUser.trade_enabled}`)
      return 'own toggles persisted; cross-user update was filtered by RLS and left values unchanged'
    })

    await step('activity feed', 'release actions emit league activity rows', async () => {
      const { data, error } = await admin
        .from('league_activity')
        .select('event_type')
        .eq('league_id', fixture.league.id)
      if (error) throw new Error(`league activity lookup: ${error.message}`)
      const events = new Set((data ?? []).map((row) => row.event_type))
      const required = [
        'free_agent_added',
        'waiver_claim_failed_add_limit',
        'faab_bid_won',
        'faab_bid_lost',
        'commissioner_faab_adjusted',
        'trade_offered',
        'trade_countered',
        'trade_edited',
        'trade_block_updated',
        'trade_completed',
      ]
      const missing = required.filter((event) => !events.has(event))
      assertCondition(missing.length === 0, `missing activity events: ${missing.join(', ')}`)
      return `observed activity events: ${required.join(', ')}`
    })

    await step('activity feed', 'authenticated feed RPC returns normalized paginated rows', async () => {
      const { data, error } = await commissioner.session.client.rpc('get_league_activity_feed', {
        p_league_id: fixture.league.id,
        p_limit: 50,
        p_offset: 0,
      })
      if (error) throw new Error(`get_league_activity_feed: ${error.message}`)
      const feed = data ?? []
      assertCondition(feed.length > 0, 'feed RPC returned no rows')

      const faabAdjust = feed.find((row) => row.transaction_type === 'commissioner_faab_adjusted')
      assertCondition(faabAdjust?.target_member_id === managerTwo.id, `faab adjust target=${faabAdjust?.target_member_id}`)
      assertCondition(typeof faabAdjust?.target_team_name === 'string' && faabAdjust.target_team_name.length > 0, 'faab adjust missing target team name')

      const freeAgentAdd = feed.find((row) => row.transaction_type === 'fa_add' && row.player_id === freeAddPlayer.id)
      assertCondition(freeAgentAdd?.member_id === commissioner.id, `free-agent feed member=${freeAgentAdd?.member_id}`)
      assertCondition(freeAgentAdd?.is_system === false, `free-agent feed is_system=${freeAgentAdd?.is_system}`)

      return `feed rows=${feed.length}; target=${faabAdjust.target_team_name}; roster transaction=${freeAgentAdd.player_name}`
    })

    await step('db security', 'service-only RPCs and direct table writes are not bypassable by authenticated clients', async () => {
      const directRpcMessage = await expectError(
        'authenticated direct create_waiver_claim_atomic',
        () => managerThree.session.client.rpc('create_waiver_claim_atomic', {
          p_league_id: fixture.league.id,
          p_member_id: managerThree.id,
          p_player_id: blockedFreeAddPlayer.id,
          p_user_id: managerThree.user.id,
          p_bid_amount: 1,
        }).then((result) => {
          if (result.error) throw new Error(result.error.message)
        }),
        'permission denied',
      )
      const { error: directWriteError } = await managerThree.session.client
        .from('faab_balances')
        .insert({
          league_id: fixture.league.id,
          league_season_id: fixture.season.id,
          member_id: managerThree.id,
          balance: 999,
        })
      assertCondition(directWriteError !== null, 'authenticated direct faab_balances insert unexpectedly succeeded')
      return `direct waiver RPC denied with "${directRpcMessage}"; direct FAAB balance insert denied`
    })

    await writeReport(context)
    const failed = rows.filter((row) => row.status !== 'PASS')
    if (failed.length > 0) process.exitCode = 1
  } catch (error) {
    await writeReport(context)
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  }
}

await main()
