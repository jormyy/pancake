import assert from 'node:assert/strict'
import process from 'node:process'
import { resolvedEnv, requireEnv } from './env.mjs'
import { findAvailablePlayers, setupMultiTeamTradeGameplayFixture } from './browser-trade-gameplay.mjs'

const env = resolvedEnv()
requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])

const rpc = async (admin, name, args) => {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
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

const accept = (fixture, tradeId, memberId, dropRosterPlayerIds = []) => rpc(
  fixture.admin,
  'accept_multi_team_trade_atomic',
  {
    p_trade_id: tradeId,
    p_accepting_member_id: memberId,
    p_drop_roster_player_ids: dropRosterPlayerIds,
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

  await expectRpcError(fixture.admin, 'accept_multi_team_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
    p_drop_roster_player_ids: [],
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

const assertReplacementAndDropLifecycle = async (fixture) => {
  await setLeagueRules(fixture, {
    roster_size: 2,
    waiver_mode: 'faab',
    trade_veto_mode: 'disabled',
    trade_veto_window_hours: 0,
  })
  const [extraPlayer] = await findAvailablePlayers(
    fixture.admin,
    fixture.league.id,
    fixture.currentSeason.id,
    1,
  )
  const { data: extraRoster, error: rosterError } = await fixture.admin
    .from('roster_players')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      member_id: fixture.recipient.id,
      player_id: extraPlayer.id,
      acquired_via: 'e2e_db_trade',
    })
    .select('id, player_id')
    .single()
  if (rosterError) throw new Error(`drop candidate insert: ${rosterError.message}`)

  const items = [
    {
      fromMemberId: fixture.proposer.id,
      toMemberId: fixture.recipient.id,
      playerId: fixture.proposerPlayer.id,
    },
    {
      fromMemberId: fixture.observer.id,
      toMemberId: fixture.recipient.id,
      playerId: fixture.observerPlayer.id,
    },
    {
      fromMemberId: fixture.recipient.id,
      toMemberId: fixture.proposer.id,
      playerId: fixture.recipientPlayer.id,
    },
  ]
  const originalTradeId = await propose(fixture, items, 'DB drop reservation before edit')
  await accept(fixture, originalTradeId, fixture.recipient.id, [extraRoster.id])

  const { count: originalReservationCount, error: reservationError } = await fixture.admin
    .from('trade_drop_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('trade_id', originalTradeId)
  if (reservationError) throw new Error(`original reservation lookup: ${reservationError.message}`)
  assert.equal(originalReservationCount, 1)

  const replacementTradeId = await rpc(fixture.admin, 'edit_multi_team_trade_atomic', {
    p_trade_id: originalTradeId,
    p_member_id: fixture.proposer.id,
    p_user_id: fixture.users[0].id,
    p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
    p_items: items,
    p_notes: 'DB edited trade replacement',
    p_expires_at: null,
  })

  const originalTrade = await fetchTrade(fixture, originalTradeId)
  assert.equal(originalTrade.status, 'edited')
  assert.equal(originalTrade.replaced_by_trade_id, replacementTradeId)
  const replacementTrade = await fetchTrade(fixture, replacementTradeId)
  assert.equal(replacementTrade.edited_from_trade_id, originalTradeId)

  const { count: staleReservationCount, error: staleReservationError } = await fixture.admin
    .from('trade_drop_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('trade_id', originalTradeId)
  if (staleReservationError) throw new Error(`stale reservation lookup: ${staleReservationError.message}`)
  assert.equal(staleReservationCount, 0, 'edited trade retained a drop reservation')

  const { data: replacementActivity, error: activityError } = await fixture.admin
    .from('league_activity')
    .select('event_type')
    .eq('related_trade_id', replacementTradeId)
  if (activityError) throw new Error(`replacement activity lookup: ${activityError.message}`)
  assert.deepEqual(replacementActivity.map((row) => row.event_type), ['trade_edited'])

  await accept(fixture, replacementTradeId, fixture.recipient.id, [extraRoster.id])
  const { data: reservedRoster, error: reservedRosterError } = await fixture.admin
    .from('roster_players')
    .select('id')
    .eq('id', extraRoster.id)
    .maybeSingle()
  if (reservedRosterError) throw new Error(`reserved roster lookup: ${reservedRosterError.message}`)
  assert(reservedRoster, 'reserved drop was deleted before unanimous acceptance')

  const { count: activeReservationCount, error: activeReservationError } = await fixture.admin
    .from('trade_drop_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('trade_id', replacementTradeId)
  if (activeReservationError) throw new Error(`active reservation lookup: ${activeReservationError.message}`)
  assert.equal(activeReservationCount, 1)

  await accept(fixture, replacementTradeId, fixture.observer.id)
  assert.equal((await fetchTrade(fixture, replacementTradeId)).status, 'completed')
  const { data: droppedRoster, error: droppedRosterError } = await fixture.admin
    .from('roster_players')
    .select('id')
    .eq('id', extraRoster.id)
    .maybeSingle()
  if (droppedRosterError) throw new Error(`completed drop lookup: ${droppedRosterError.message}`)
  assert.equal(droppedRoster, null, 'reserved player survived trade completion')
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
  const { error: participantError } = await fixture.admin.from('trade_participants').insert([
    { trade_id: tradeId, member_id: fixture.proposer.id, sort_order: 0, is_initiator: true, accepted_at: past },
    { trade_id: tradeId, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: past },
    { trade_id: tradeId, member_id: fixture.observer.id, sort_order: 2, is_initiator: false, accepted_at: past },
  ])
  if (participantError) throw new Error(`offseason participant insert: ${participantError.message}`)

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

const run = async () => {
  const fixture = await setupMultiTeamTradeGameplayFixture(env, 0)
  await assertAggregateFaabRejectionIsAtomic(fixture)
  await assertExpiredAcceptanceCommits(fixture)
  await assertReplacementAndDropLifecycle(fixture)
  await assertConcurrentAcceptanceCompletesOnce(fixture)
  await assertCompletionFailureIsTerminal(fixture)
  console.log('PASS multi-team trade DB atomicity: aggregate FAAB, reservations, replacement, concurrency, terminal failures')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
