import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { ownScenarioResource } from './scenario-resource-owner.mjs'

const fixtureCreatedPlayerIds = new Set()

/** @typedef {import('@supabase/supabase-js').SupabaseClient<import('../../types/database.js').Database>} AdminClient */
/** @typedef {{ supabaseUrl: string, serviceRoleKey: string, anonKey: string, frontendUrl?: string, apiBaseUrl?: string }} FixtureEnv */
/** @typedef {{ id?: string, email: string, password: string, username: string, displayName: string, teamName: string }} FixtureUser */
/** @typedef {{ registerLeague: (id: string) => void, registerUser: (id: string) => void, registerPlayer: (id: string) => void, registerCleanup: (name: string, dispose: () => Promise<void>) => void, dispose: () => Promise<void> }} FixtureResourceOwner */

let fixtureSequence = 0
let fixtureOwnerSequence = 0

/** @param {AdminClient} admin @param {FixtureUser} user */
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

/** @param {FixtureEnv} env @param {string} email @param {string} password */
const signInClient = async (env, email, password) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return client
}

/** @param {AdminClient} admin @param {string} leagueId */
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

/** @param {AdminClient} admin @param {string} leagueId */
const sortedLeagueMembers = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league members lookup: ${error.message}`)
  return data ?? []
}

/**
 * @param {AdminClient} admin
 * @param {string} leagueId
 * @param {string} leagueSeasonId
 * @param {number} count
 * @param {(id: string) => void} [registerCreatedPlayer]
 */
export const findAvailablePlayers = async (admin, leagueId, leagueSeasonId, count, registerCreatedPlayer = () => {}) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin.from('roster_players').select('player_id').eq('league_id', leagueId).eq('league_season_id', leagueSeasonId),
    admin.from('players').select('id, display_name, position, nba_team').not('display_name', 'is', null)
      .order('display_name', { ascending: true }).limit(300),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const available = (players ?? []).filter((player) => player.display_name && !rosteredIds.has(player.id))
  if (available.length >= count) {
    const selected = available.slice(0, count)
    for (const player of selected) {
      if (fixtureCreatedPlayerIds.has(player.id)) registerCreatedPlayer(player.id)
    }
    return selected
  }
  for (const player of available) {
    if (fixtureCreatedPlayerIds.has(player.id)) registerCreatedPlayer(player.id)
  }

  /** @type {('PG' | 'SG' | 'SF' | 'PF' | 'C')[]} */
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
  for (const player of fallbackPlayers ?? []) {
    fixtureCreatedPlayerIds.add(player.id)
    registerCreatedPlayer(player.id)
  }
  return [...available, ...(fallbackPlayers ?? [])].slice(0, count)
}

/** @param {AdminClient} admin @param {string} leagueId @param {string} memberId @param {number} seasonYear @param {number} [round] */
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

/** @param {AdminClient} admin @param {{ ambient?: boolean }} [options] @returns {FixtureResourceOwner} */
export const createFixtureResourceOwner = (admin, { ambient = true } = {}) => {
  fixtureOwnerSequence += 1
  /** @type {string | null} */
  let leagueId = null
  /** @type {Set<string>} */
  const userIds = new Set()
  /** @type {Set<string>} */
  const playerIds = new Set()
  /** @type {{ name: string, dispose: () => Promise<void> }[]} */
  const cleanups = []
  let disposed = false
  const owner = {
    /** @param {string} id */
    registerLeague: (id) => { leagueId = id },
    /** @param {string} id */
    registerUser: (id) => { userIds.add(id) },
    /** @param {string} id */
    registerPlayer: (id) => { playerIds.add(id) },
    /** @param {string} name @param {() => Promise<void>} dispose */
    registerCleanup: (name, dispose) => { cleanups.push({ name, dispose }) },
    dispose: async () => {
      if (disposed) return
      const failures = []
      const remainingCleanups = []
      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup.dispose()
        } catch (error) {
          remainingCleanups.unshift(cleanup)
          failures.push(new Error(`${cleanup.name}: ${error instanceof Error ? error.message : String(error)}`))
        }
      }
      cleanups.splice(0, cleanups.length, ...remainingCleanups)
      if (leagueId) {
        const { error: terminalError } = await admin
          .from('trades')
          .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
          .eq('league_id', leagueId)
          .eq('status', 'accepted')
        const { error: transactionError } = await admin
          .from('roster_transactions')
          .delete()
          .eq('league_id', leagueId)
        const { error: pickError } = await admin
          .from('draft_picks')
          .update({ rookie_draft_id: null })
          .eq('league_id', leagueId)
        const { error: draftError } = await admin.from('drafts').delete().eq('league_id', leagueId)
        const { error } = await admin.from('leagues').delete().eq('id', leagueId)
        if (terminalError) failures.push(new Error(`fixture accepted-trade cleanup: ${terminalError.message}`))
        if (transactionError) failures.push(new Error(`fixture transaction cleanup: ${transactionError.message}`))
        if (pickError) failures.push(new Error(`fixture draft-pick cleanup: ${pickError.message}`))
        if (draftError) failures.push(new Error(`fixture draft cleanup: ${draftError.message}`))
        if (error) failures.push(new Error(`fixture league cleanup: ${error.message}`))
        else leagueId = null
      }
      const results = await Promise.all([...userIds].map(async (userId) => ({
        userId,
        result: await admin.auth.admin.deleteUser(userId),
      })))
      for (const { userId, result } of results) {
        if (result.error) failures.push(new Error(`fixture user cleanup ${userId}: ${result.error.message}`))
        else userIds.delete(userId)
      }
      for (const playerId of [...playerIds]) {
        const { error: playerError } = await admin.from('players').delete().eq('id', playerId)
        if (playerError) {
          failures.push(new Error(`fixture player cleanup ${playerId}: ${playerError.message}`))
          continue
        }
        fixtureCreatedPlayerIds.delete(playerId)
        playerIds.delete(playerId)
      }
      disposed = cleanups.length === 0 && leagueId === null && userIds.size === 0 && playerIds.size === 0
      if (failures.length > 0) throw new AggregateError(failures, 'Fixture cleanup failed')
    },
  }
  if (ambient) ownScenarioResource(`fixture:${fixtureOwnerSequence}`, `fixture ${fixtureOwnerSequence}`, owner.dispose)
  return owner
}

/**
 * @param {FixtureEnv} env
 * @param {number} season
 * @param {{ memberCount?: number, includeFuturePicks?: boolean }} [options]
 */
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
  const resources = createFixtureResourceOwner(admin)
  /** @type {(FixtureUser & { id: string })[]} */
  const createdUsers = []

    for (const user of users) {
      const createdUser = await createConfirmedUser(admin, user)
      createdUsers.push(createdUser)
      resources.registerUser(createdUser.id)
    }
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
    resources.registerLeague(league.id)
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
    if (!proposer.team_name || !recipient.team_name) throw new Error('trade fixture members require team names')
    /** @type {Omit<typeof proposer, 'team_name'> & { team_name: string }} */
    const namedProposer = { ...proposer, team_name: proposer.team_name }
    /** @type {Omit<typeof recipient, 'team_name'> & { team_name: string }} */
    const namedRecipient = { ...recipient, team_name: recipient.team_name }
    const [proposerPlayer, recipientPlayer] = await findAvailablePlayers(
      admin,
      league.id,
      currentSeason.id,
      2,
      resources.registerPlayer,
    )
    if (!proposerPlayer?.display_name || !recipientPlayer?.display_name) {
      throw new Error('trade fixture players require display names')
    }
    /** @type {Omit<typeof proposerPlayer, 'display_name'> & { display_name: string }} */
    const namedProposerPlayer = { ...proposerPlayer, display_name: proposerPlayer.display_name }
    /** @type {Omit<typeof recipientPlayer, 'display_name'> & { display_name: string }} */
    const namedRecipientPlayer = { ...recipientPlayer, display_name: recipientPlayer.display_name }
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

    return {
      admin, runId, password, users: createdUsers, league, currentSeason,
      proposer: namedProposer, recipient: namedRecipient, observer,
      proposerPlayer: namedProposerPlayer, recipientPlayer: namedRecipientPlayer,
      targetFuturePickYear, proposerFuturePick, recipientFuturePick,
      dispose: resources.dispose,
      registerCreatedPlayer: resources.registerPlayer,
    }
}

/** @param {FixtureEnv} env @param {number} season */
export const setupMultiTeamTradeGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3, includeFuturePicks: false })
    if (!fixture.observer?.team_name) throw new Error('browser multi-team trade fixture requires a named third member')
    /** @type {Omit<typeof fixture.observer, 'team_name'> & { team_name: string }} */
    const namedObserver = { ...fixture.observer, team_name: fixture.observer.team_name }
    const [observerPlayer] = await findAvailablePlayers(
      fixture.admin,
      fixture.league.id,
      fixture.currentSeason.id,
      1,
      fixture.registerCreatedPlayer,
    )
    if (!observerPlayer?.display_name) throw new Error('multi-team fixture player requires a display name')
    /** @type {Omit<typeof observerPlayer, 'display_name'> & { display_name: string }} */
    const namedObserverPlayer = { ...observerPlayer, display_name: observerPlayer.display_name }
    const { error } = await fixture.admin.from('roster_players').insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      member_id: namedObserver.id,
      player_id: namedObserverPlayer.id,
      acquired_via: 'draft',
      acquisition_cost: 1,
    })
    if (error) throw new Error(`multi-team observer roster seed insert: ${error.message}`)
    return { ...fixture, observer: namedObserver, observerPlayer: namedObserverPlayer }
}
