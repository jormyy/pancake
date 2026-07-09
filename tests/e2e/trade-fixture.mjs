import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

let fixtureSequence = 0

const createConfirmedUser = async (admin, user) => {
  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: { username: user.username, display_name: user.displayName },
  })
  if (error) throw new Error(`createUser ${user.email}: ${error.message}`)
  if (!data.user) throw new Error(`createUser ${user.email}: no user returned`)
  return { ...user, id: data.user.id }
}

const signInClient = async (env, email, password) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return client
}

const fetchCurrentSeason = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  if (error) throw new Error(`current season lookup: ${error.message}`)
  return data
}

const sortedLeagueMembers = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league members lookup: ${error.message}`)
  return data ?? []
}

export const findAvailablePlayers = async (admin, leagueId, leagueSeasonId, count) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin.from('roster_players').select('player_id').eq('league_id', leagueId).eq('league_season_id', leagueSeasonId),
    admin.from('players').select('id, display_name, position, nba_team').not('display_name', 'is', null)
      .order('display_name', { ascending: true }).limit(300),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const available = (players ?? []).filter((player) => player.display_name && !rosteredIds.has(player.id))
  if (available.length >= count) return available.slice(0, count)

  const positions = ['PG', 'SG', 'SF', 'PF', 'C']
  const fallbackRows = Array.from({ length: count - available.length }, (_, index) => {
    const position = positions[(available.length + index) % positions.length]
    return {
      first_name: 'E2E',
      last_name: `Trade ${Date.now()} ${index + 1}`,
      nba_team: 'FA',
      position,
      status: 'Active',
      eligible_positions: [position],
      years_exp: 1,
    }
  })
  const { data: fallbackPlayers, error: fallbackError } = await admin
    .from('players').insert(fallbackRows).select('id, display_name, position, nba_team')
  if (fallbackError) throw new Error(`fallback player seed insert: ${fallbackError.message}`)
  return [...available, ...(fallbackPlayers ?? [])].slice(0, count)
}

const findFuturePickForMember = async (admin, leagueId, memberId, seasonYear, round = 1) => {
  const { data, error } = await admin.from('draft_picks').select(`
      id, season_year, round, original_owner_id, current_owner_id,
      original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
    `).eq('league_id', leagueId).eq('current_owner_id', memberId).eq('season_year', seasonYear)
    .eq('round', round).eq('is_used', false).single()
  if (error) throw new Error(`future pick lookup ${memberId} ${seasonYear} round ${round}: ${error.message}`)
  return {
    id: data.id,
    seasonYear: data.season_year,
    round: data.round,
    originalOwnerId: data.original_owner_id,
    currentOwnerId: data.current_owner_id,
    originalTeamName: data.original_owner?.team_name ?? 'Unknown',
  }
}

export const disposeFixtureResources = async (admin, leagueId, userIds) => {
  if (leagueId) {
    const { error } = await admin.from('leagues').delete().eq('id', leagueId)
    if (error) throw new Error(`fixture league cleanup: ${error.message}`)
  }
  const results = await Promise.all(userIds.map((userId) => admin.auth.admin.deleteUser(userId)))
  const failure = results.find((result) => result.error)
  if (failure?.error) throw new Error(`fixture user cleanup: ${failure.error.message}`)
}

export const createFixtureResourceOwner = (admin) => {
  let leagueId = null
  const userIds = []
  let disposed = false
  return {
    registerLeague: (id) => { leagueId = id },
    registerUser: (id) => { userIds.push(id) },
    dispose: async () => {
      if (disposed) return
      disposed = true
      await disposeFixtureResources(admin, leagueId, userIds)
    },
  }
}

export const setupTradeGameplayFixture = async (
  env,
  season,
  { memberCount = 2, includeFuturePicks = true } = {},
) => {
  fixtureSequence += 1
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}-${fixtureSequence}`
  const password = `Pancake-trade-${runId}!`
  const users = Array.from({ length: memberCount }, (_, index) => index + 1).map((n) => ({
    email: `pancake-trade-${runId}-${n}@example.com`,
    password,
    username: `pancake_trade_${runId}_${n}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Trade ${runId} #${n}`,
    teamName: `Trade Team ${n}`,
  }))
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const createdUsers = []
  let leagueId = null

  try {
    for (const user of users) createdUsers.push(await createConfirmedUser(admin, user))
    const { error: profileError } = await admin.from('profiles').upsert(createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    })), { onConflict: 'id' })
    if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

    const proposerClient = await signInClient(env, createdUsers[0].email, password)
    const { data: league, error: createError } = await proposerClient.rpc('create_league', {
      p_name: `Pancake Browser Trade ${runId}`,
      p_team_name: createdUsers[0].teamName,
      p_auction_budget: 200,
    })
    if (createError) throw new Error(`create_league: ${createError.message}`)
    leagueId = league.id
    for (const user of createdUsers.slice(1)) {
      const memberClient = await signInClient(env, user.email, password)
      const { error: joinError } = await memberClient.rpc('join_league_by_invite_code', {
        p_invite_code: league.invite_code,
        p_team_name: user.teamName,
      })
      if (joinError) throw new Error(`join_league_by_invite_code ${user.email}: ${joinError.message}`)
    }

    const currentSeason = await fetchCurrentSeason(admin, league.id)
    const members = await sortedLeagueMembers(admin, league.id)
    if (members.length !== memberCount) throw new Error(`expected ${memberCount} members, got ${members.length}`)
    const proposer = members.find((member) => member.user_id === createdUsers[0].id)
    const recipient = members.find((member) => member.user_id === createdUsers[1].id)
    const observer = memberCount > 2 ? members.find((member) => member.user_id === createdUsers[2].id) : null
    if (!proposer || !recipient) throw new Error('trade fixture member lookup failed')
    const [proposerPlayer, recipientPlayer] = await findAvailablePlayers(admin, league.id, currentSeason.id, 2)
    const targetFuturePickYear = currentSeason.season_year + 5
    const [proposerFuturePick, recipientFuturePick] = includeFuturePicks
      ? await Promise.all([
        findFuturePickForMember(admin, league.id, proposer.id, targetFuturePickYear),
        findFuturePickForMember(admin, league.id, recipient.id, targetFuturePickYear),
      ])
      : [null, null]
    const { error: rosterError } = await admin.from('roster_players').insert([
      { league_id: league.id, league_season_id: currentSeason.id, member_id: proposer.id, player_id: proposerPlayer.id, acquired_via: 'draft', acquisition_cost: 1 },
      { league_id: league.id, league_season_id: currentSeason.id, member_id: recipient.id, player_id: recipientPlayer.id, acquired_via: 'draft', acquisition_cost: 1 },
    ])
    if (rosterError) throw new Error(`roster seed insert: ${rosterError.message}`)
    const { error: statusError } = await admin.from('leagues').update({ status: 'active' }).eq('id', league.id)
    if (statusError) throw new Error(`trade fixture status flip: ${statusError.message}`)

    let disposed = false
    return {
      admin, runId, password, users: createdUsers, league, currentSeason, proposer, recipient, observer,
      proposerPlayer, recipientPlayer, targetFuturePickYear, proposerFuturePick, recipientFuturePick,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await disposeFixtureResources(admin, league.id, createdUsers.map((user) => user.id))
      },
    }
  } catch (error) {
    await disposeFixtureResources(admin, leagueId, createdUsers.map((user) => user.id)).catch(() => {})
    throw error
  }
}

export const setupMultiTeamTradeGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3, includeFuturePicks: false })
  if (!fixture.observer) throw new Error('browser multi-team trade fixture did not create a third member')
  const [observerPlayer] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 1)
  const { error } = await fixture.admin.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    member_id: fixture.observer.id,
    player_id: observerPlayer.id,
    acquired_via: 'draft',
    acquisition_cost: 1,
  })
  if (error) {
    await fixture.dispose().catch(() => {})
    throw new Error(`multi-team observer roster seed insert: ${error.message}`)
  }
  return { ...fixture, observer: fixture.observer, observerPlayer }
}
