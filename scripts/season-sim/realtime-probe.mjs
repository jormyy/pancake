import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { assertTarget, delay } from './common.mjs'

export async function startRealtimeProbe(c, keys) {
  assertTarget(keys.API_URL, 'api')
  const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  const events = []
  const initial = await c.rest(c.users[0], `matchups?select=id,home_points,away_points&league_season_id=eq.${c.leagueSeasonId}`)
  await client.realtime.setAuth(c.users[0].token)
  const scores = new Map(initial.map(row => [row.id, row]))
  const topic = `league-matchups:${c.leagueSeasonId}:probe`
  const channel = client.channel(topic, { config: { private: true } }).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matchups', filter: `league_season_id=eq.${c.leagueSeasonId}` }, payload => {
    const row = payload.new, before = scores.get(row.id)
    events.push({ commit: payload.commit_timestamp, row, scoreChanged: !!before && (before.home_points !== row.home_points || before.away_points !== row.away_points), receivedAt: new Date().toISOString() })
    scores.set(row.id, row)
  })
  let status
  channel.subscribe(value => { status = value })
  for (let attempt = 0; attempt < 100 && status !== 'SUBSCRIBED'; attempt++) {
    assert.ok(!['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status), `Client Realtime subscription failed: ${status}`)
    await delay(100)
  }
  assert.equal(status, 'SUBSCRIBED', 'Client must join the private matchup Realtime channel')
  const syncAuth = realtimeAuth(client.realtime, c.users[0].token)
  return { topic, events, syncAuth: () => syncAuth(c.users[0].token), async verify(matchups) {
    for (let attempt = 0; attempt < 50 && !events.length; attempt++) await delay(100)
    assert.ok(events.some(event => event.scoreChanged), 'Subscribed client must receive a real matchup score change')
    const current = new Map(matchups.map(row => [row.id, row]))
    const synchronized = () => [...new Map(events.map(event => [event.row.id, event.row]))].every(([id, received]) => {
      const row = current.get(id)
      return !row || ['home_points', 'away_points', 'is_finalized', 'winner_member_id'].every(key => received[key] === row[key])
    })
    for (let attempt = 0; attempt < 50 && !synchronized(); attempt++) await delay(100)
    const last = new Map(events.map(event => [event.row.id, event]))
    for (const row of matchups) {
      const received = last.get(row.id)?.row
      if (!received) continue
      for (const key of ['home_points', 'away_points', 'is_finalized', 'winner_member_id']) assert.equal(received[key], row[key], `Client Realtime ${key} agrees with authenticated matchup read`)
    }
    return { topic, status, events: events.length, passed: true, source: 'hooks/use-matchup-data.ts; lib/scoring.ts', sample: events.find(event => event.scoreChanged) }
  }, close: () => client.removeAllChannels() }
}

export function realtimeAuth(client, initialToken) {
  let current = initialToken
  return async token => {
    if (token === current) return
    await client.setAuth(token)
    current = token
  }
}
