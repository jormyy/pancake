import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'
import { findAvailablePlayers, setupMultiTeamTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'dbUrl', 'serviceRoleKey', 'anonKey'])

const rpc = async (admin, name, args) => {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
}

const executeRecoverySql = (sql) => {
  execFileSync('psql', [env.dbUrl, '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

const queryRecoveryJson = (sql) => {
  const output = execFileSync('psql', [env.dbUrl, '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`SQL JSON output missing: ${output}`)
  return JSON.parse(output.slice(start, end + 1))
}

const expectRpcError = async (admin, name, args, messagePart) => {
  const { error } = await admin.rpc(name, args)
  assert(error, `${name} unexpectedly succeeded`)
  assert.match(error.message, new RegExp(messagePart, 'i'))
  return error
}

const setLeagueRules = async (fixture, rules) => {
  const { error } = await fixture.admin
    .from('leagues')
    .update(rules)
    .eq('id', fixture.league.id)
  if (error) throw new Error(`league rules update: ${error.message}`)
}

const setBalances = async (fixture, balances) => {
  const rows = balances.map(([memberId, balance]) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    member_id: memberId,
    balance,
    updated_at: new Date().toISOString(),
  }))
  const { error } = await fixture.admin
    .from('faab_balances')
    .upsert(rows, { onConflict: 'league_id,league_season_id,member_id' })
  if (error) throw new Error(`FAAB balance upsert: ${error.message}`)
}

const faabRoutes = (fixture, amount = 40) => [
  {
    fromMemberId: fixture.proposer.id,
    toMemberId: fixture.recipient.id,
    faabAmount: amount,
  },
  {
    fromMemberId: fixture.proposer.id,
    toMemberId: fixture.observer.id,
    faabAmount: amount,
  },
]

const propose = (fixture, items, notes) => rpc(fixture.admin, 'propose_multi_team_trade_atomic', {
  p_league_id: fixture.league.id,
  p_league_season_id: fixture.currentSeason.id,
  p_proposer_member_id: fixture.proposer.id,
  p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
  p_items: items,
  p_notes: notes,
  p_expires_at: null,
})

const accept = (fixture, tradeId, memberId) => rpc(
  fixture.admin,
  'accept_trade_atomic',
  {
    p_trade_id: tradeId,
    p_accepting_member_id: memberId,
  },
)

const fetchTrade = async (fixture, tradeId) => {
  const { data, error } = await fixture.admin
    .from('trades')
    .select('id, status, replaced_by_trade_id, edited_from_trade_id, completion_failure_reason')
    .eq('id', tradeId)
    .single()
  if (error) throw new Error(`trade lookup ${tradeId}: ${error.message}`)
  return data
}

const balanceFor = async (fixture, memberId) => {
  const { data, error } = await fixture.admin
    .from('faab_balances')
    .select('balance')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', memberId)
    .single()
  if (error) throw new Error(`FAAB balance lookup ${memberId}: ${error.message}`)
  return data.balance
}

const assertAggregateFaabRejectionIsAtomic = async (fixture) => {
  await setLeagueRules(fixture, { waiver_mode: 'faab', trade_veto_mode: 'commissioner', trade_veto_window_hours: 1 })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 0],
    [fixture.observer.id, 0],
  ])
  const tradeId = await propose(fixture, faabRoutes(fixture), 'DB aggregate FAAB acceptance guard')
  await setBalances(fixture, [[fixture.proposer.id, 60]])

  await expectRpcError(fixture.admin, 'accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
  }, 'enough FAAB')

  const { data: participant, error } = await fixture.admin
    .from('trade_participants')
    .select('accepted_at')
    .eq('trade_id', tradeId)
    .eq('member_id', fixture.recipient.id)
    .single()
  if (error) throw new Error(`rejected participant lookup: ${error.message}`)
  assert.equal(participant.accepted_at, null, 'failed aggregate validation partially accepted the participant')
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'pending')
}

const assertMultiTeamPayloadBounds = async (fixture) => {
  await expectRpcError(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id],
    p_items: Array.from({ length: 101 }, () => ({
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.recipient.id,
      faabAmount: 1,
    })),
    p_notes: 'DB oversized multi-team payload',
    p_expires_at: null,
  }, 'between 1 and 100 items')
  await expectRpcError(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id],
    p_items: [{
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.recipient.id,
      faabAmount: '999999999999999999999999',
    }],
    p_notes: 'DB oversized FAAB payload',
    p_expires_at: null,
  }, 'exactly one player, pick, or positive FAAB')
  await expectRpcError(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id],
    p_items: [{ fromMemberId: fixture.proposer.id, toMemberId: fixture.recipient.id, faabAmount: 1 }],
    p_notes: 'x'.repeat(2001),
    p_expires_at: null,
  }, 'notes must not exceed 2000 bytes')
}

const assertExpiredAcceptanceCommits = async (fixture) => {
  await setLeagueRules(fixture, { waiver_mode: 'faab', trade_veto_mode: 'commissioner', trade_veto_window_hours: 1 })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 0],
    [fixture.observer.id, 0],
  ])
  const tradeId = await propose(fixture, faabRoutes(fixture, 1), 'DB expired acceptance transition')
  const { error: expiryError } = await fixture.admin
    .from('trades')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', tradeId)
  if (expiryError) throw new Error(`trade expiry update: ${expiryError.message}`)

  const result = await accept(fixture, tradeId, fixture.recipient.id)
  assert.equal(result.expired, true)
  assert.equal(result.allAccepted, false)
  assert.deepEqual(new Set(result.participantMemberIds), new Set([
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ]))
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'expired')
}

const assertLazyRosterEnforcement = async (fixture) => {
  await setLeagueRules(fixture, {
    status: 'active',
    roster_size: 1,
    ir_slots: 1,
    taxi_slots: 1,
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 100],
    [fixture.observer.id, 100],
  ])

  const recipientClient = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await recipientClient.auth.signInWithPassword({
    email: fixture.users[1].email,
    password: fixture.users[1].password,
  })
  if (signInError) throw new Error(`lazy-roster sign in ${fixture.users[1].email}: ${signInError.message}`)

  const twoTeamTradeId = await rpc(fixture.admin, 'propose_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_recipient_member_id: fixture.recipient.id,
    p_offer_player_ids: [fixture.proposerPlayer.id],
    p_request_player_ids: [],
    p_offer_pick_ids: [],
    p_request_pick_ids: [],
    p_offer_faab_amount: 0,
    p_request_faab_amount: 1,
    p_notes: 'DB two-team lazy roster completion',
    p_expires_at: null,
  })
  await accept(fixture, twoTeamTradeId, fixture.recipient.id)
  assert.equal((await fetchTrade(fixture, twoTeamTradeId)).status, 'completed')

  const activeCount = async (memberId) => {
    const { count, error } = await fixture.admin.from('roster_players')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', memberId)
      .eq('is_on_ir', false)
      .eq('is_on_taxi', false)
    if (error) throw new Error(`active roster count: ${error.message}`)
    return count
  }
  assert.equal(await activeCount(fixture.recipient.id), 2, 'two-team trade did not complete above the roster cap')

  await expectRpcError(recipientClient, 'set_player_slot_moves_atomic', {
    p_member_id: fixture.recipient.id,
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_game_date: new Date().toISOString().slice(0, 10),
    p_week_number: 1,
    p_moves: [],
  }, 'over the active player limit')

  const [freeAgent, proposerExtraOne, proposerExtraTwo] = await findAvailablePlayers(
    fixture.admin,
    fixture.league.id,
    fixture.currentSeason.id,
    3,
    fixture.registerCreatedPlayer,
  )
  await expectRpcError(recipientClient, 'add_free_agent_atomic', {
    p_member_id: fixture.recipient.id,
    p_league_id: fixture.league.id,
    p_player_id: freeAgent.id,
  }, 'active roster is full')

  const { error: injuryError } = await fixture.admin.from('players')
    .update({ injury_status: 'Out' }).eq('id', fixture.recipientPlayer.id)
  if (injuryError) throw new Error(`IR eligibility update: ${injuryError.message}`)
  const { data: recipientRoster, error: recipientRosterError } = await fixture.admin.from('roster_players')
    .select('id').eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.recipient.id).eq('player_id', fixture.recipientPlayer.id).single()
  if (recipientRosterError) throw new Error(`IR roster lookup: ${recipientRosterError.message}`)
  await rpc(fixture.admin, 'toggle_ir_atomic', {
    p_roster_player_id: recipientRoster.id,
    p_to_ir: true,
    p_user_id: fixture.users[1].id,
  })
  assert.equal(await activeCount(fixture.recipient.id), 1, 'IR move did not reduce the over-cap active roster')

  const { error: extraRosterError } = await fixture.admin.from('roster_players').insert([
    {
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      member_id: fixture.proposer.id,
      player_id: proposerExtraOne.id,
      acquired_via: 'e2e_db_trade',
    },
    {
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      member_id: fixture.proposer.id,
      player_id: proposerExtraTwo.id,
      acquired_via: 'e2e_db_trade',
    },
  ])
  if (extraRosterError) throw new Error(`over-cap proposer roster insert: ${extraRosterError.message}`)
  assert.equal(await activeCount(fixture.proposer.id), 2)

  const multiTradeId = await propose(fixture, [
    {
      fromMemberId: fixture.observer.id,
      toMemberId: fixture.recipient.id,
      playerId: fixture.observerPlayer.id,
    },
    { fromMemberId: fixture.recipient.id, toMemberId: fixture.proposer.id, faabAmount: 1 },
    { fromMemberId: fixture.proposer.id, toMemberId: fixture.observer.id, faabAmount: 1 },
  ], 'DB multi-team lazy roster completion')
  const { data: proposerConsent, error: consentError } = await fixture.admin.from('trade_participants')
    .select('accepted_at').eq('trade_id', multiTradeId).eq('member_id', fixture.proposer.id).single()
  if (consentError) throw new Error(`over-cap proposer consent lookup: ${consentError.message}`)
  assert(proposerConsent.accepted_at, 'over-cap proposer was not auto-consented')

  await accept(fixture, multiTradeId, fixture.recipient.id)
  await accept(fixture, multiTradeId, fixture.observer.id)
  assert.equal((await fetchTrade(fixture, multiTradeId)).status, 'completed')
  assert.equal(await activeCount(fixture.recipient.id), 2, 'multi-team trade did not complete above the roster cap')

  const { error: rookieError } = await fixture.admin.from('players')
    .update({ nba_draft_number: 1, years_exp: 0 }).eq('id', proposerExtraOne.id)
  if (rookieError) throw new Error(`taxi eligibility update: ${rookieError.message}`)
  const { data: taxiRoster, error: taxiRosterError } = await fixture.admin.from('roster_players')
    .select('id').eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.proposer.id).eq('player_id', proposerExtraOne.id).single()
  if (taxiRosterError) throw new Error(`taxi roster lookup: ${taxiRosterError.message}`)
  await rpc(fixture.admin, 'toggle_taxi_atomic', {
    p_roster_player_id: taxiRoster.id,
    p_to_taxi: true,
    p_user_id: fixture.users[0].id,
  })
  assert.equal(await activeCount(fixture.proposer.id), 1, 'taxi move did not reduce the over-cap active roster')

  const { data: dropRoster, error: dropRosterError } = await fixture.admin.from('roster_players')
    .select('id').eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.recipient.id).eq('player_id', fixture.observerPlayer.id).single()
  if (dropRosterError) throw new Error(`drop roster lookup: ${dropRosterError.message}`)
  await rpc(recipientClient, 'drop_player_atomic', { p_roster_player_id: dropRoster.id })
  assert.equal(await activeCount(fixture.recipient.id), 1, 'drop did not reduce the over-cap active roster')
}

const assertConcurrentAcceptanceCompletesOnce = async (fixture) => {
  await setLeagueRules(fixture, {
    roster_size: 20,
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 0],
    [fixture.observer.id, 0],
  ])
  const tradeId = await propose(fixture, faabRoutes(fixture), 'DB concurrent multi-team acceptance')
  const results = await Promise.all([
    accept(fixture, tradeId, fixture.recipient.id),
    accept(fixture, tradeId, fixture.observer.id),
  ])
  assert.equal(results.filter((result) => result.allAccepted).length, 1)
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'completed')
  assert.equal(await balanceFor(fixture, fixture.proposer.id), 20)
  assert.equal(await balanceFor(fixture, fixture.recipient.id), 40)
  assert.equal(await balanceFor(fixture, fixture.observer.id), 40)
}

const assertCompetingStandardAndMultiTeamTradesSerialize = async (fixture) => {
  await setLeagueRules(fixture, {
    roster_size: 20,
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  const [player] = await findAvailablePlayers(
    fixture.admin,
    fixture.league.id,
    fixture.currentSeason.id,
    1,
    fixture.registerCreatedPlayer,
  )
  const { error: rosterError } = await fixture.admin.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    member_id: fixture.proposer.id,
    player_id: player.id,
    acquired_via: 'e2e_db_trade_race',
  })
  if (rosterError) throw new Error(`trade race roster insert: ${rosterError.message}`)

  const standardTradeId = await rpc(fixture.admin, 'propose_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_recipient_member_id: fixture.recipient.id,
    p_offer_player_ids: [player.id],
    p_request_player_ids: [],
    p_offer_pick_ids: [],
    p_request_pick_ids: [],
    p_offer_faab_amount: 0,
    p_request_faab_amount: 1,
    p_notes: 'DB standard versus multi-team race',
    p_expires_at: null,
  })
  const multiTradeId = await rpc(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.observer.id],
    p_items: [{
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.observer.id,
      playerId: player.id,
    }],
    p_notes: 'DB multi-team versus standard race',
    p_expires_at: null,
  })

  const results = await Promise.allSettled([
    rpc(fixture.admin, 'accept_trade_atomic', {
      p_trade_id: standardTradeId,
      p_accepting_member_id: fixture.recipient.id,
    }),
    accept(fixture, multiTradeId, fixture.observer.id),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)

  const [standardTrade, multiTrade] = await Promise.all([
    fetchTrade(fixture, standardTradeId),
    fetchTrade(fixture, multiTradeId),
  ])
  assert.equal([standardTrade, multiTrade].filter((trade) => trade.status === 'completed').length, 1)
  const { data: owner, error: ownerError } = await fixture.admin
    .from('roster_players')
    .select('member_id')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('player_id', player.id)
    .single()
  if (ownerError) throw new Error(`trade race owner lookup: ${ownerError.message}`)
  assert([fixture.recipient.id, fixture.observer.id].includes(owner.member_id))
}

/** @param {any} fixture @param {{ playerId?: string, pickId?: string, notes: string }} asset */
const proposeStandardAssetTrade = (fixture, { playerId, pickId, notes }) => rpc(fixture.admin, 'propose_trade_atomic', {
  p_league_id: fixture.league.id,
  p_league_season_id: fixture.currentSeason.id,
  p_proposer_member_id: fixture.proposer.id,
  p_recipient_member_id: fixture.recipient.id,
  p_offer_player_ids: playerId ? [playerId] : [],
  p_request_player_ids: [],
  p_offer_pick_ids: pickId ? [pickId] : [],
  p_request_pick_ids: [],
  p_offer_faab_amount: 0,
  p_request_faab_amount: 1,
  p_notes: notes,
  p_expires_at: null,
})

const assertInactivePlayerAcceptanceAndDirectTriggerReject = async (fixture) => {
  await setLeagueRules(fixture, {
    roster_size: 20,
    waiver_mode: 'faab',
    trade_veto_mode: 'commissioner',
    trade_veto_window_hours: 1,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 100],
  ])
  const [player] = await findAvailablePlayers(
    fixture.admin,
    fixture.league.id,
    fixture.currentSeason.id,
    1,
    fixture.registerCreatedPlayer,
  )
  const { error: insertError } = await fixture.admin.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    member_id: fixture.proposer.id,
    player_id: player.id,
    acquired_via: 'e2e_db_inactive_acceptance',
  })
  if (insertError) throw new Error(`inactive acceptance roster insert: ${insertError.message}`)
  const { data: roster, error: rosterError } = await fixture.admin.from('roster_players')
    .select('id').eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.proposer.id).eq('player_id', player.id).single()
  if (rosterError) throw new Error(`inactive acceptance roster lookup: ${rosterError.message}`)

  for (const inactiveColumn of ['is_on_ir', 'is_on_taxi']) {
    const tradeId = await proposeStandardAssetTrade(fixture, {
      playerId: player.id,
      notes: `DB ${inactiveColumn} acceptance assertion`,
    })
    const { error: inactiveError } = await fixture.admin.from('roster_players')
      .update({ [inactiveColumn]: true }).eq('id', roster.id)
    if (inactiveError) throw new Error(`${inactiveColumn} setup: ${inactiveError.message}`)

    await expectRpcError(fixture.admin, 'accept_trade_atomic', {
      p_trade_id: tradeId,
      p_accepting_member_id: fixture.recipient.id,
    }, 'active roster side')
    assert.equal((await fetchTrade(fixture, tradeId)).status, 'pending')

    const { error: restoreError } = await fixture.admin.from('roster_players')
      .update({ [inactiveColumn]: false }).eq('id', roster.id)
    if (restoreError) throw new Error(`${inactiveColumn} restore: ${restoreError.message}`)
  }

  const triggerTradeId = await proposeStandardAssetTrade(fixture, {
    playerId: player.id,
    notes: 'DB direct accepted-status trigger assertion',
  })
  const { error: taxiError } = await fixture.admin.from('roster_players').update({ is_on_taxi: true }).eq('id', roster.id)
  if (taxiError) throw new Error(`direct trigger taxi setup: ${taxiError.message}`)
  const { error: triggerError } = await fixture.admin.from('trades')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', triggerTradeId)
  assert(triggerError, 'direct accepted-status update bypassed the canonical asset assertion trigger')
  assert.match(triggerError.message, /active roster side/i)
  assert.equal((await fetchTrade(fixture, triggerTradeId)).status, 'pending')
  const { error: restoreError } = await fixture.admin.from('roster_players').update({ is_on_taxi: false }).eq('id', roster.id)
  if (restoreError) throw new Error(`direct trigger taxi restore: ${restoreError.message}`)
}

const proposerAvailablePick = async (fixture) => {
  const { data, error } = await fixture.admin.from('draft_picks')
    .select('id, current_owner_id, is_used')
    .eq('league_id', fixture.league.id)
    .eq('current_owner_id', fixture.proposer.id)
    .eq('is_used', false)
    .order('season_year', { ascending: false })
    .order('round', { ascending: true })
    .limit(1)
    .single()
  if (error) throw new Error(`proposer available pick lookup: ${error.message}`)
  return data
}

const assertStaleAndUsedPickAcceptanceReject = async (fixture) => {
  await setLeagueRules(fixture, {
    waiver_mode: 'faab',
    trade_veto_mode: 'commissioner',
    trade_veto_window_hours: 1,
  })
  await setBalances(fixture, [[fixture.recipient.id, 100]])
  const pick = await proposerAvailablePick(fixture)
  const tradeId = await proposeStandardAssetTrade(fixture, {
    pickId: pick.id,
    notes: 'DB stale and used pick acceptance assertion',
  })

  const { error: usedError } = await fixture.admin.from('draft_picks').update({ is_used: true }).eq('id', pick.id)
  if (usedError) throw new Error(`used pick setup: ${usedError.message}`)
  await expectRpcError(fixture.admin, 'accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
  }, 'Draft-pick asset is no longer owned')
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'pending')

  const { error: staleError } = await fixture.admin.from('draft_picks')
    .update({ is_used: false, current_owner_id: fixture.recipient.id }).eq('id', pick.id)
  if (staleError) throw new Error(`stale pick setup: ${staleError.message}`)
  await expectRpcError(fixture.admin, 'accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
  }, 'Draft-pick asset is no longer owned')
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'pending')

  const { error: restoreError } = await fixture.admin.from('draft_picks')
    .update({ current_owner_id: fixture.proposer.id }).eq('id', pick.id)
  if (restoreError) throw new Error(`stale pick restore: ${restoreError.message}`)
}

const assertCompetingAcceptedPickTradesSerialize = async (fixture) => {
  await setLeagueRules(fixture, {
    waiver_mode: 'faab',
    trade_veto_mode: 'commissioner',
    trade_veto_window_hours: 1,
  })
  await setBalances(fixture, [
    [fixture.recipient.id, 100],
    [fixture.observer.id, 100],
  ])
  const pick = await proposerAvailablePick(fixture)
  const standardTradeId = await proposeStandardAssetTrade(fixture, {
    pickId: pick.id,
    notes: 'DB competing standard accepted-pick reservation',
  })
  const multiTradeId = await rpc(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.observer.id],
    p_items: [{
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.observer.id,
      pickId: pick.id,
    }],
    p_notes: 'DB competing multi-team accepted-pick reservation',
    p_expires_at: null,
  })

  const results = await Promise.allSettled([
    accept(fixture, standardTradeId, fixture.recipient.id),
    accept(fixture, multiTradeId, fixture.observer.id),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  const trades = await Promise.all([fetchTrade(fixture, standardTradeId), fetchTrade(fixture, multiTradeId)])
  assert.equal(trades.filter((trade) => trade.status === 'accepted').length, 1)
  assert.equal(trades.filter((trade) => trade.status === 'pending').length, 1)

  const { data: persistedPick, error: pickError } = await fixture.admin.from('draft_picks')
    .select('current_owner_id, is_used').eq('id', pick.id).single()
  if (pickError) throw new Error(`reserved pick lookup: ${pickError.message}`)
  assert.equal(persistedPick.current_owner_id, fixture.proposer.id)
  assert.equal(persistedPick.is_used, false)

  const acceptedTrade = trades.find((trade) => trade.status === 'accepted')
  const { error: cleanupError } = await fixture.admin.from('trades')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() }).eq('id', acceptedTrade.id)
  if (cleanupError) throw new Error(`accepted pick reservation cleanup: ${cleanupError.message}`)
}

const assertTwoTeamUsesCanonicalRoutes = async (fixture) => {
  await setLeagueRules(fixture, {
    status: 'active',
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 100],
  ])
  const tradeId = await rpc(fixture.admin, 'propose_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_recipient_member_id: fixture.recipient.id,
    p_offer_player_ids: [],
    p_request_player_ids: [],
    p_offer_pick_ids: [],
    p_request_pick_ids: [],
    p_offer_faab_amount: 10,
    p_request_faab_amount: 1,
    p_notes: 'DB canonical two-team FAAB route',
    p_expires_at: null,
  })
  const result = await rpc(fixture.admin, 'accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
  })
  assert.equal(result.expired, false)
  assert.equal(result.allAccepted, true)
  assert.deepEqual(new Set(result.participantMemberIds), new Set([
    fixture.proposer.id,
    fixture.recipient.id,
  ]))
  assert.equal((await fetchTrade(fixture, tradeId)).status, 'completed')
  assert.equal(await balanceFor(fixture, fixture.proposer.id), 91)
  assert.equal(await balanceFor(fixture, fixture.recipient.id), 109)

  const { data: items, error: itemError } = await fixture.admin
    .from('trade_items')
    .select('from_member_id, to_member_id, faab_amount')
    .eq('trade_id', tradeId)
  if (itemError) throw new Error(`canonical two-team item lookup: ${itemError.message}`)
  assert.deepEqual(new Set(items.map((item) => JSON.stringify(item))), new Set([
    JSON.stringify({
      from_member_id: fixture.proposer.id,
      to_member_id: fixture.recipient.id,
      faab_amount: 10,
    }),
    JSON.stringify({
      from_member_id: fixture.recipient.id,
      to_member_id: fixture.proposer.id,
      faab_amount: 1,
    }),
  ]))
}

const assertCompletionFailureIsTerminal = async (fixture) => {
  await setLeagueRules(fixture, {
    status: 'offseason',
    waiver_mode: 'faab',
    trade_veto_mode: 'commissioner',
    trade_veto_window_hours: 1,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 60],
    [fixture.recipient.id, 0],
    [fixture.observer.id, 0],
  ])
  const past = new Date(Date.now() - 60_000).toISOString()
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'accepted',
      accepted_at: past,
      veto_window_expires_at: past,
      is_multi_team: true,
      notes: 'DB offseason terminal completion failure',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`offseason accepted trade insert: ${tradeError.message}`)
  const tradeId = trade.id
  executeRecoverySql(`
    INSERT INTO public.trade_participants
      (trade_id, member_id, sort_order, is_initiator, accepted_at)
    VALUES
      ('${tradeId}', '${fixture.proposer.id}', 0, true, '${past}'),
      ('${tradeId}', '${fixture.recipient.id}', 1, false, '${past}'),
      ('${tradeId}', '${fixture.observer.id}', 2, false, '${past}');
  `)
  const { error: itemError } = await fixture.admin.from('trade_items').insert(
    faabRoutes(fixture).map((item) => ({
      trade_id: tradeId,
      side: 'proposer',
      from_member_id: item.fromMemberId,
      to_member_id: item.toMemberId,
      faab_amount: item.faabAmount,
    })),
  )
  if (itemError) throw new Error(`offseason trade item insert: ${itemError.message}`)

  const processed = await rpc(fixture.admin, 'process_due_accepted_trades_atomic', { p_limit: 50 })
  const result = processed.find((row) => row.trade_id === tradeId)
  assert(result, 'due-trade processor did not return the target trade')
  assert.equal(result.status, 'expired_terminal_failure')
  assert.equal(result.error_code, 'PT001')
  assert.match(result.error_message, /enough FAAB/i)
  assert.deepEqual(new Set(result.participant_member_ids), new Set([
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ]))

  const completedTrade = await fetchTrade(fixture, tradeId)
  assert.equal(completedTrade.status, 'expired')
  assert.match(completedTrade.completion_failure_reason, /enough FAAB/i)
}

const assertVetoRowsSurviveMemberHistoryPagination = async (fixture) => {
  const personalRows = Array.from({ length: 2_000 }, (_, index) => ({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.observer.id,
    recipient_member_id: fixture.recipient.id,
    status: 'completed',
    proposed_at: new Date(Date.now() + index * 1000).toISOString(),
    completed_at: new Date().toISOString(),
    notes: `pagination history ${index}`,
  }))
  const { data: personalTrades, error: historyError } = await fixture.admin.from('trades').insert(personalRows).select('id')
  if (historyError) throw new Error(`pagination history insert: ${historyError.message}`)
  const { error: historyParticipantError } = await fixture.admin.from('trade_participants').insert(
    personalTrades.flatMap((trade) => [
      { trade_id: trade.id, member_id: fixture.observer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
      { trade_id: trade.id, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: new Date().toISOString() },
    ]),
  )
  if (historyParticipantError) throw new Error(`pagination participant insert: ${historyParticipantError.message}`)

  const { data: vetoTrade, error: vetoTradeError } = await fixture.admin.from('trades').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.proposer.id,
    recipient_member_id: fixture.recipient.id,
    status: 'accepted',
    proposed_at: '2000-01-01T00:00:00.000Z',
    accepted_at: new Date().toISOString(),
    veto_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    notes: 'observer veto row must bypass member history pagination',
  }).select('id').single()
  if (vetoTradeError) throw new Error(`observer veto trade insert: ${vetoTradeError.message}`)
  const { error: vetoParticipantError } = await fixture.admin.from('trade_participants').insert([
    { trade_id: vetoTrade.id, member_id: fixture.proposer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
    { trade_id: vetoTrade.id, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: new Date().toISOString() },
  ])
  if (vetoParticipantError) throw new Error(`observer veto participant insert: ${vetoParticipantError.message}`)

  const observerUser = fixture.users[2]
  const observerClient = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await observerClient.auth.signInWithPassword({
    email: observerUser.email,
    password: observerUser.password,
  })
  if (signInError) throw new Error(`observer sign in: ${signInError.message}`)
  const fetchPage = async (cursor = null) => {
    const { data: refs, error: refsError } = await observerClient.rpc('get_trade_page_refs', {
      p_member_id: fixture.observer.id,
      p_league_id: fixture.league.id,
      p_limit: 40,
      p_cursor: cursor,
    })
    if (refsError) throw new Error(`get_trade_page_refs pagination: ${refsError.message}`)
    const { data: trades, error: tradesError } = await observerClient.from('trades')
      .select('id, notes').in('id', refs.map((ref) => ref.trade_id))
    if (tradesError) throw new Error(`trade page rows: ${tradesError.message}`)
    const byId = new Map(trades.map((trade) => [trade.id, trade]))
    return { refs, rows: refs.map((ref) => byId.get(ref.trade_id)).filter(Boolean) }
  }
  const firstPage = await fetchPage()
  const rows = firstPage.rows
  assert.equal(rows.length, 40)
  assert(rows.some((trade) => trade.id === vetoTrade.id), 'vetoable observer trade was displaced by personal history')
  const nextCursor = firstPage.refs.at(-1)?.cursor_token
  assert(nextCursor, 'first trade page did not return a next cursor')
  const nextPage = await fetchPage(nextCursor)
  const nextRows = nextPage.rows
  assert.equal(nextRows.length, 40)
  assert.equal(nextRows.some((trade) => rows.some((firstPage) => firstPage.id === trade.id)), false)
  assert([...rows, ...nextRows].some((trade) => trade.notes?.startsWith('pagination history ')))

  executeRecoverySql('ANALYZE public.trades; ANALYZE public.trade_participants;')
  const explain = queryRecoveryJson(`
    SELECT set_config('request.jwt.claim.sub', '${observerUser.id}', false);
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM public.get_trade_page_refs('${fixture.observer.id}', '${fixture.league.id}', 40, NULL);
  `)
  const plan = explain[0].Plan
  assert.equal(plan['Actual Rows'], 40)
  assert(plan['Shared Hit Blocks'] < 2_500, `trade page read ${plan['Shared Hit Blocks']} shared blocks`)
  assert(plan['Actual Total Time'] < 100, `trade page took ${plan['Actual Total Time']} ms`)
  const { error: terminalError } = await fixture.admin
    .from('trades')
    .update({ status: 'vetoed', vetoed_at: new Date().toISOString() })
    .eq('id', vetoTrade.id)
  if (terminalError) throw new Error(`observer veto trade cleanup: ${terminalError.message}`)
}

const run = async () => {
  const fixture = await setupMultiTeamTradeGameplayFixture(env, 0)
  await assertMultiTeamPayloadBounds(fixture)
  await assertAggregateFaabRejectionIsAtomic(fixture)
  await assertExpiredAcceptanceCommits(fixture)
  await assertLazyRosterEnforcement(fixture)
  await assertConcurrentAcceptanceCompletesOnce(fixture)
  await assertCompetingStandardAndMultiTeamTradesSerialize(fixture)
  await assertInactivePlayerAcceptanceAndDirectTriggerReject(fixture)
  await assertStaleAndUsedPickAcceptanceReject(fixture)
  await assertCompetingAcceptedPickTradesSerialize(fixture)
  await assertTwoTeamUsesCanonicalRoutes(fixture)
  await assertVetoRowsSurviveMemberHistoryPagination(fixture)
  await assertCompletionFailureIsTerminal(fixture)
  console.log('PASS multi-team trade DB: canonical asset assertions, lazy roster limits, keyset pages, mixed-trade races, and terminal failures')
}

runWithScenarioResourceOwner('multi-team trade DB', run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
