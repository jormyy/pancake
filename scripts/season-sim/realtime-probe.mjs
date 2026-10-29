import assert from 'node:assert/strict'
import { sql, sqlJson } from './local-stack.mjs'
import { createClient } from '@supabase/supabase-js'
import { assertTarget, delay } from './common.mjs'

export async function startRealtimeProbe(c, keys) {
  assertTarget(keys.API_URL, 'api')
  const published = await sqlJson("SELECT coalesce(jsonb_agg(tablename ORDER BY tablename),'[]') FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public'")
  if (!published.includes('matchups')) {
    assert.deepEqual(published, ['draft_budgets','draft_picks','draft_room_members','drafts','nominations','snake_draft_picks'])
    return startDraftProbe(c, keys)
  }
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
  const syncAuth = realtimeAuth(client.realtime, c.users[0].token, c)
  return { topic, events, readyToVerify: () => events.some(event => event.scoreChanged), syncAuth: () => syncAuth(c.users[0].token), async verify(matchups) {
    assert.equal(status, 'SUBSCRIBED', 'Client Realtime channel must remain subscribed through verification')
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
  }, close: () => { syncAuth.close(); return client.removeAllChannels() } }
}

function createDraftConnection(url, key) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  return {
    setAuth: async token => { await client.realtime.setAuth(token) },
    subscribe: (topic, filter, receive, status, ready) => {
      client.channel(topic, { config: { private: true } }).on('postgres_changes', filter, receive)
        .on('system', {}, event => { if (event.extension === 'postgres_changes' && event.status === 'ok') ready() })
        .subscribe(value => status(value))
    },
    close: async () => { await client.removeAllChannels() },
  }
}

export async function startDraftProbe(c, keys, { execute = sql, clientFactory = createDraftConnection, pause = delay } = {}) {
  const drafts = await c.rest(c.users[0], `drafts?select=id,pick_timer_seconds&league_id=eq.${c.leagueId}&order=created_at.desc&limit=1`)
  assert.equal(drafts.length, 1, 'The completed setup draft is required for the publication probe')
  const draft = drafts[0].id, originalTimer = drafts[0].pick_timer_seconds, changedTimer = originalTimer === 127 ? 128 : 127, events = []
  const client = clientFactory(keys.API_URL, keys.ANON_KEY)
  let status, closed = false, feedReady = false
  const topic = `draft:${draft}:probe`
  await client.setAuth(c.users[0].token)
  const syncAuth = realtimeAuth(client, c.users[0].token, c)
  const close = async () => {
    if (closed) return
    closed = true
    syncAuth.close()
    await client.close()
  }
  try {
    client.subscribe(topic,
      { event: 'UPDATE', schema: 'public', table: 'drafts', filter: `id=eq.${draft}` }, payload => {
        events.push({ commit: payload.commit_timestamp, row: payload.new, receivedAt: new Date().toISOString() })
      }, value => { status = value }, () => { feedReady = true })
    for (let attempt = 0; attempt < 100 && (status !== 'SUBSCRIBED' || !feedReady); attempt++) {
      assert.ok(!['CHANNEL_ERROR','TIMED_OUT','CLOSED'].includes(status), `Draft subscription failed: ${status}`)
      await pause(100)
    }
    assert.equal(status, 'SUBSCRIBED')
    assert.equal(feedReady, true, 'The draft database feed must be ready before its probe write')
    await execute(`UPDATE public.drafts SET pick_timer_seconds=${changedTimer} WHERE id='${draft}'`)
    for (let attempt = 0; attempt < 50 && !events.some(event => event.row.pick_timer_seconds === changedTimer); attempt++) await pause(100)
    assert.ok(events.some(event => event.row.id === draft && event.row.pick_timer_seconds === changedTimer), 'The retained draft publication must deliver its row change')
    await execute(`UPDATE public.drafts SET pick_timer_seconds=${originalTimer == null ? 'NULL' : originalTimer} WHERE id='${draft}'`)
    return { topic, events, readyToVerify: () => events.length > 0, syncAuth: () => syncAuth(c.users[0].token), close,
      async verify() {
        assert.equal(status, 'SUBSCRIBED')
        for (let attempt = 0; attempt < 50 && !events.length; attempt++) await pause(100)
        assert.ok(events.some(event => event.row.id === draft && event.row.pick_timer_seconds === changedTimer), 'The retained draft publication must deliver its row change')
        const current = await c.rest(c.users[0], `drafts?select=id,pick_timer_seconds&id=eq.${draft}`)
        assert.deepEqual(current.map(row => ({ id: row.id, pick_timer_seconds: row.pick_timer_seconds })), [{ id: draft, pick_timer_seconds: originalTimer }])
        return { topic, status, events: events.length, passed: true, source: 'lib/draft.ts', publication: 'six draft tables', sample: events.at(-1) }
      },
    }
  } catch (error) {
    await execute(`UPDATE public.drafts SET pick_timer_seconds=${originalTimer == null ? 'NULL' : originalTimer} WHERE id='${draft}'`)
    await close()
    throw error
  }
}

export function realtimeAuth(client, initialToken, context) {
  let current = initialToken
  const sync = async token => {
    if (token === current) return
    await client.setAuth(token)
    current = token
  }
  sync.close = context?.onTokenRefresh(user => user === context.users[0] ? sync(user.token) : undefined) ?? (() => {})
  return sync
}
