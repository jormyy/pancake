import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolvedEnv, requireEnv } from './env.mjs'

export const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'dbUrl', 'serviceRoleKey', 'anonKey'])

export const rpc = async (admin, name, args) => {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new Error(`${name}: ${error.message}`)
  return data
}

export const executeRecoverySql = (sql) => {
  execFileSync('psql', [env.dbUrl, '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

export const queryRecoveryJson = (sql) => {
  const output = execFileSync('psql', [env.dbUrl, '--quiet', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error(`SQL JSON output missing: ${output}`)
  return JSON.parse(output.slice(start, end + 1))
}

export const expectRpcError = async (admin, name, args, messagePart) => {
  const { error } = await admin.rpc(name, args)
  assert(error, `${name} unexpectedly succeeded`)
  assert.match(error.message, new RegExp(messagePart, 'i'))
  return error
}

export const setLeagueRules = async (fixture, rules) => {
  const { error } = await fixture.admin
    .from('leagues')
    .update(rules)
    .eq('id', fixture.league.id)
  if (error) throw new Error(`league rules update: ${error.message}`)
}

export const setBalances = async (fixture, balances) => {
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

export const faabRoutes = (fixture, amount = 40) => [
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

export const propose = (fixture, items, notes) => rpc(fixture.admin, 'propose_multi_team_trade_atomic', {
  p_league_id: fixture.league.id,
  p_league_season_id: fixture.currentSeason.id,
  p_proposer_member_id: fixture.proposer.id,
  p_participant_member_ids: [fixture.proposer.id, fixture.recipient.id, fixture.observer.id],
  p_items: items,
  p_notes: notes,
  p_expires_at: null,
})

export const accept = (fixture, tradeId, memberId) => rpc(
  fixture.admin,
  'accept_trade_atomic',
  {
    p_trade_id: tradeId,
    p_accepting_member_id: memberId,
  },
)

export const fetchTrade = async (fixture, tradeId) => {
  const { data, error } = await fixture.admin
    .from('trades')
    .select('id, status, replaced_by_trade_id, edited_from_trade_id, completion_failure_reason')
    .eq('id', tradeId)
    .single()
  if (error) throw new Error(`trade lookup ${tradeId}: ${error.message}`)
  return data
}

export const balanceFor = async (fixture, memberId) => {
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

export const assertTradeNotificationRecipients = async (fixture, eventType, tradeId, memberIds) => {
  const { data, error } = await fixture.admin
    .from('notification_outbox')
    .select('member_id, dedupe_key, delivered_at, dead_lettered_at')
    .like('dedupe_key', `${eventType}:${tradeId}:%`)
  if (error) throw new Error(`${eventType} outbox lookup: ${error.message}`)
  assert.deepEqual(new Set(data.map((entry) => entry.member_id)), new Set(memberIds))
  assert.equal(new Set(data.map((entry) => entry.dedupe_key)).size, memberIds.length)
  assert(data.every((entry) => entry.delivered_at === null && entry.dead_lettered_at === null))
}
