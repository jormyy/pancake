import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const url = new URL(status.API_URL)
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '57821')
const env = { supabaseUrl: status.API_URL, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceRoleKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY }
const newClient = key => createClient(env.supabaseUrl, key, { auth: { persistSession: false }, global: { fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set('x-request-id', crypto.randomUUID()); return fetch(input, { ...init, headers }) } } })
const admin = newClient(env.serviceRoleKey)
execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:57822/postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT cron.alter_job(jobid,active:=false) FROM cron.job; UPDATE private.worker_controls SET paused=true;'], { stdio: 'ignore' })
const players = JSON.parse(readFileSync('tests/fixtures/trade-values/pancake-players.json', 'utf8'))
for (let offset = 0; offset < players.length; offset += 500) {
  const rows = players.slice(offset, offset + 500).map(player => {
    const names = player.display_name.split(' ')
    return { id: player.id, first_name: names.shift(), last_name: names.join(' '), nba_team: player.nba_team, position: player.position, eligible_positions: player.eligible_positions, status: 'Active' }
  })
  const { error } = await admin.from('players').upsert(rows)
  if (error) throw error
}
const response = await fetch(`${env.supabaseUrl}/functions/v1/sync-trade-values`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': 'pancake-local-edge-auth-probe-token' },
  body: JSON.stringify({ format: 'json', content: readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8') }),
})
assert.equal(response.status, 200, await response.text())
const password = 'Pancake-value-readers-2026!'
const users = []
const clients = []
for (let index = 0; index < 2; index++) {
  const email = `p4-values-${Date.now()}-${index}@example.test`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `p4_values_${Date.now()}_${index}`, display_name: `Value Tester ${index + 1}` } })
  if (error) throw error
  users.push({ id: data.user.id, email })
  const client = newClient(env.anonKey)
  const signed = await client.auth.signInWithPassword({ email, password })
  if (signed.error) throw signed.error
  clients.push(client)
}
const created = await clients[0].rpc('create_league', { p_name: 'Value Reader Verification', p_team_name: 'Value Team 1', p_auction_budget: 200 })
if (created.error) throw created.error
const league = created.data
const joined = await clients[1].rpc('join_league_by_invite_code', { p_invite_code: league.invite_code, p_team_name: 'Value Team 2' })
if (joined.error) throw joined.error
const season = await admin.from('league_seasons').select('id,season_year').eq('league_id', league.id).eq('is_current', true).single()
if (season.error) throw season.error
const members = await admin.from('league_members').select('id,user_id').eq('league_id', league.id)
if (members.error) throw members.error
const fixture = { league, users, currentSeason: season.data, proposer: members.data.find(member => member.user_id === users[0].id), recipient: members.data.find(member => member.user_id === users[1].id) }
const activated = await admin.from('leagues').update({ status: 'active' }).eq('id', league.id)
if (activated.error) throw activated.error
const valueRows = JSON.parse(readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')).data
const first = players.find(player => player.display_name === 'Victor Wembanyama')
const second = players.find(player => player.display_name === 'Shai Gilgeous-Alexander')
assert.ok(first && second)
for (const [member, player] of [[fixture.proposer, first], [fixture.recipient, second]]) {
  const { error } = await admin.from('roster_players').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: member.id, player_id: player.id, acquired_via: 'draft', acquisition_cost: 1 })
  if (error) throw error
}
const client = newClient(env.anonKey)
const { data: signed, error: signError } = await client.auth.signInWithPassword({ email: fixture.users[0].email, password })
if (signError) throw signError
const items = [
  { fromMemberId: fixture.proposer.id, toMemberId: fixture.recipient.id, kind: 'player', playerId: first.id },
  { fromMemberId: fixture.recipient.id, toMemberId: fixture.proposer.id, kind: 'player', playerId: second.id },
]
const quoteResponse = await fetch(`${env.supabaseUrl}/functions/v1/api/trades/estimate`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${signed.session.access_token}`, 'x-request-id': crypto.randomUUID() },
  body: JSON.stringify({ leagueId: fixture.league.id, memberId: fixture.proposer.id, items }),
})
const quoteBody = await quoteResponse.json()
assert.equal(quoteResponse.status, 200, JSON.stringify(quoteBody))
const quote = quoteBody.quote
const { data: trade, error: tradeError } = await admin.from('trades').insert({
  league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
  proposer_member_id: fixture.proposer.id, recipient_member_id: fixture.recipient.id, status: 'pending', notes: 'Value reader verification',
}).select('id').single()
if (tradeError) throw tradeError
const { error: participantError } = await admin.from('trade_participants').insert([
  { trade_id: trade.id, league_id: fixture.league.id, member_id: fixture.proposer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
  { trade_id: trade.id, league_id: fixture.league.id, member_id: fixture.recipient.id, sort_order: 1, is_initiator: false },
])
if (participantError) throw participantError
const { error: itemError } = await admin.from('trade_items').insert(items.map((item, index) => ({
  trade_id: trade.id, side: index === 0 ? 'proposer' : 'recipient', player_id: item.playerId,
  from_member_id: item.fromMemberId, to_member_id: item.toMemberId,
})))
if (itemError) throw itemError
const { error: estimateError } = await admin.from('trade_estimates').insert({ trade_id: trade.id, quote_id: quote.id })
if (estimateError) throw estimateError
const evidence = { leagueId: fixture.league.id, memberId: fixture.proposer.id, userEmail: fixture.users[0].email, playerId: first.id, otherPlayerId: second.id, tradeId: trade.id,
  expected: { first: valueRows.find(row => row.id === 'victorwembanyama').value / 10, second: valueRows.find(row => row.id === 'shaigilgeousalexander').value / 10 } }
writeFileSync('../reader-fixture.json', JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence))
