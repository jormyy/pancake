import assert from 'node:assert/strict'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { findAvailablePlayers, setupMultiTeamTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { assertCompletionFailureIsTerminal } from './multi-team-trade-db-notifications.mjs'
import { assertVetoRowsSurviveMemberHistoryPagination } from './multi-team-trade-db-pagination.mjs'
import {
  accept,
  assertTradeNotificationRecipients,
  balanceFor,
  env,
  expectRpcError,
  faabRoutes,
  fetchTrade,
  propose,
  rpc,
  setBalances,
  setLeagueRules,
} from './multi-team-trade-db-support.mjs'

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
    p_items: [{
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.recipient.id,
      faabAmount: 1,
    }],
    p_notes: 'DB undersized multi-team payload',
    p_expires_at: null,
  }, 'requires at least 3 teams')
  await expectRpcError(fixture.admin, 'propose_multi_team_trade_atomic', {
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_proposer_member_id: fixture.proposer.id,
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
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
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
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
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
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
  await assertTradeNotificationRecipients(fixture, 'trade_expired', tradeId, [
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ])
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
  await assertTradeNotificationRecipients(fixture, 'trade_completed', tradeId, [
    fixture.proposer.id,
    fixture.recipient.id,
    fixture.observer.id,
  ])
}

const assertCompetingStandardAndMultiTeamTradesSerialize = async (fixture) => {
  await setLeagueRules(fixture, {
    roster_size: 20,
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  await setBalances(fixture, [
    [fixture.proposer.id, 100],
    [fixture.recipient.id, 100],
    [fixture.observer.id, 100],
  ])
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
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
    p_items: [
      {
        fromMemberId: fixture.proposer.id,
        toMemberId: fixture.observer.id,
        playerId: player.id,
      },
      {
        fromMemberId: fixture.recipient.id,
        toMemberId: fixture.proposer.id,
        faabAmount: 1,
      },
    ],
    p_notes: 'DB multi-team versus standard race',
    p_expires_at: null,
  })
  await accept(fixture, multiTradeId, fixture.recipient.id)

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

  // A pick that is used or leaves its owner expires every pending offer that
  // includes it; the reason stays on the trade and acceptance no longer applies.
  const expectOfferExpired = async (expiredTradeId, reasonPart) => {
    await expectRpcError(fixture.admin, 'accept_trade_atomic', {
      p_trade_id: expiredTradeId,
      p_accepting_member_id: fixture.recipient.id,
    }, 'no longer pending')
    const trade = await fetchTrade(fixture, expiredTradeId)
    assert.equal(trade.status, 'expired')
    assert.match(trade.completion_failure_reason ?? '', new RegExp(reasonPart, 'i'))
    const { data: activity, error: activityError } = await fixture.admin.from('league_activity')
      .select('event_type').eq('related_trade_id', expiredTradeId).eq('event_type', 'trade_expired')
    if (activityError) throw new Error(`expired offer activity lookup: ${activityError.message}`)
    assert.equal(activity.length, 1, 'lost pick asset did not record one trade_expired activity row')
  }

  const { error: usedError } = await fixture.admin.from('draft_picks').update({ is_used: true }).eq('id', pick.id)
  if (usedError) throw new Error(`used pick setup: ${usedError.message}`)
  await expectOfferExpired(tradeId, 'has been used in the draft')

  const { error: unusedError } = await fixture.admin.from('draft_picks').update({ is_used: false }).eq('id', pick.id)
  if (unusedError) throw new Error(`used pick restore: ${unusedError.message}`)
  const staleTradeId = await proposeStandardAssetTrade(fixture, {
    pickId: pick.id,
    notes: 'DB stale pick acceptance assertion',
  })
  const { error: staleError } = await fixture.admin.from('draft_picks')
    .update({ current_owner_id: fixture.recipient.id }).eq('id', pick.id)
  if (staleError) throw new Error(`stale pick setup: ${staleError.message}`)
  await expectOfferExpired(staleTradeId, 'is no longer owned by')

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
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
    p_items: [
      {
        fromMemberId: fixture.proposer.id,
        toMemberId: fixture.observer.id,
        pickId: pick.id,
      },
      {
        fromMemberId: fixture.recipient.id,
        toMemberId: fixture.observer.id,
        faabAmount: 1,
      },
    ],
    p_notes: 'DB competing multi-team accepted-pick reservation',
    p_expires_at: null,
  })
  await accept(fixture, multiTradeId, fixture.recipient.id)

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
