import assert from 'node:assert/strict'
import { resolvedEnv, requireEnv } from './env.mjs'
import { setupMultiTeamTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey'])

async function insertTrade(fixture, overrides = {}) {
  const { data, error } = await fixture.admin.from('trades').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    proposer_member_id: fixture.proposer.id,
    recipient_member_id: fixture.recipient.id,
    status: 'pending',
    is_multi_team: true,
    ...overrides,
  }).select('id').single()
  if (error) throw new Error(`trade insert: ${error.message}`)
  return data.id
}

async function insertParticipants(fixture, tradeId, accepted = false) {
  const now = new Date().toISOString()
  const { error } = await fixture.admin.from('trade_participants').insert([
    { trade_id: tradeId, member_id: fixture.proposer.id, sort_order: 0, is_initiator: true, accepted_at: now },
    { trade_id: tradeId, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false, accepted_at: accepted ? now : null },
    { trade_id: tradeId, member_id: fixture.observer.id, sort_order: 2, is_initiator: false, accepted_at: accepted ? now : null },
  ])
  if (error) throw new Error(`participant insert: ${error.message}`)
}

async function recipients(fixture, eventType, tradeId) {
  const { data, error } = await fixture.admin.from('notification_outbox')
    .select('member_id, dedupe_key').eq('event_type', eventType).contains('data', { tradeId })
  if (error) throw new Error(`${eventType} outbox lookup: ${error.message}`)
  return data
}

async function assertRecipients(fixture, eventType, tradeId, expected) {
  const rows = await recipients(fixture, eventType, tradeId)
  assert.deepEqual(new Set(rows.map((row) => row.member_id)), new Set(expected), `${eventType} recipients`)
  assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, rows.length, `${eventType} dedupe keys`)
}

async function offeredTrade(fixture, overrides = {}) {
  const tradeId = await insertTrade(fixture, overrides)
  await insertParticipants(fixture, tradeId)
  return tradeId
}

async function run() {
  const fixture = await setupMultiTeamTradeGameplayFixture(env, 0)
  const all = [fixture.proposer.id, fixture.recipient.id, fixture.observer.id]
  const nonInitiators = [fixture.recipient.id, fixture.observer.id]

  const offered = await offeredTrade(fixture)
  await assertRecipients(fixture, 'trade_offered', offered, nonInitiators)

  const counterOne = await offeredTrade(fixture, { countered_from_trade_id: offered })
  const counterTwo = await offeredTrade(fixture, { countered_from_trade_id: offered })
  await assertRecipients(fixture, 'trade_countered', counterOne, nonInitiators)
  await assertRecipients(fixture, 'trade_countered', counterTwo, nonInitiators)

  const editedOne = await offeredTrade(fixture, { edited_from_trade_id: offered })
  const editedTwo = await offeredTrade(fixture, { edited_from_trade_id: offered })
  await assertRecipients(fixture, 'trade_edited', editedOne, nonInitiators)
  await assertRecipients(fixture, 'trade_edited', editedTwo, nonInitiators)

  const { error: partialError } = await fixture.admin.from('trade_participants')
    .update({ accepted_at: new Date().toISOString() })
    .eq('trade_id', offered).eq('member_id', fixture.recipient.id)
  if (partialError) throw new Error(`partial accept: ${partialError.message}`)
  await assertRecipients(fixture, 'trade_participant_accepted', offered, [fixture.proposer.id])

  const { error: finalError } = await fixture.admin.from('trade_participants')
    .update({ accepted_at: new Date().toISOString() })
    .eq('trade_id', offered).eq('member_id', fixture.observer.id)
  if (finalError) throw new Error(`final accept: ${finalError.message}`)
  await assertRecipients(fixture, 'trade_accepted', offered, [fixture.proposer.id, fixture.recipient.id])

  for (const [status, eventType, expected] of [
    ['rejected', 'trade_rejected', [fixture.proposer.id]],
    ['withdrawn', 'trade_withdrawn', nonInitiators],
    ['expired', 'trade_expired', all],
  ]) {
    const tradeId = await offeredTrade(fixture)
    const { error } = await fixture.admin.from('trades').update({ status }).eq('id', tradeId)
    if (error) throw new Error(`${status} transition: ${error.message}`)
    await assertRecipients(fixture, eventType, tradeId, expected)
  }

  for (const [status, eventType] of [['vetoed', 'trade_vetoed'], ['completed', 'trade_completed']]) {
    const tradeId = await insertTrade(fixture, {
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      veto_window_expires_at: new Date(Date.now() + 60_000).toISOString(),
    })
    await insertParticipants(fixture, tradeId, true)
    const { error } = await fixture.admin.from('trades').update({ status }).eq('id', tradeId)
    if (error) throw new Error(`${status} transition: ${error.message}`)
    await assertRecipients(fixture, eventType, tradeId, all)
  }

  console.log('PASS trade notification outbox: all actions transactional with complete recipients')
}

runWithScenarioResourceOwner('trade notification outbox DB', run).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
