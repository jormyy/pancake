import assert from 'node:assert/strict'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../_shared/database.ts'
import { createScheduledProjectionLoader } from './projections.ts'

const client = createClient<Database>('http://127.0.0.1:9', 'fixture-key', { auth: { autoRefreshToken: false, persistSession: false } })
const first = { league_id: 'league', league_season_id: 'season', member_id: 'first' }
const second = { ...first, member_id: 'second' }
const context = { date: '2026-10-29', seasonYear: 2027 }

Deno.test('scheduled projections share league date work while returning only each current roster', async () => {
  const native = globalThis.fetch
  const requests: { path: string; body: Record<string, unknown> | null }[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    const body = request.method === 'POST' ? await request.json() : null
    requests.push({ path: url.pathname, body })
    if (url.pathname.endsWith('/roster_players')) {
      assert.equal(url.searchParams.get('league_id'), 'eq.league')
      assert.equal(url.searchParams.get('league_season_id'), 'eq.season')
      assert.equal(url.searchParams.get('member_id'), 'in.(first,second)')
      assert.equal(url.searchParams.get('is_on_ir'), 'eq.false')
      assert.equal(url.searchParams.get('is_on_taxi'), 'eq.false')
      return Response.json([{ player_id: 'a' }, { player_id: 'b' }])
    }
    return Response.json(body.p_player_ids.map((id: string) => ({ player_id: id, projection_fantasy_points: id === 'a' ? 10 : 20 })))
  }
  try {
    const load = createScheduledProjectionLoader(client, [first, second])
    assert.deepEqual((await load(first, context, ['a'])).map(row => row.player_id), ['a'])
    assert.deepEqual((await load(second, context, ['b'])).map(row => row.player_id), ['b'])
    assert.equal(requests.length, 2)
    assert.deepEqual((await load(second, context, ['b', 'new'])).map(row => row.player_id), ['b', 'new'])
    assert.equal(requests.length, 3)
    assert.deepEqual(requests[2].body?.p_player_ids, ['new'])
    await load(first, { ...context, date: '2026-10-30' }, ['a'])
    assert.equal(requests.length, 4)
    const freshRun = createScheduledProjectionLoader(client, [first, second])
    await freshRun(first, context, ['a'])
    assert.equal(requests.length, 6)
  } finally { globalThis.fetch = native }
})

Deno.test('scheduled projection batches preserve players beyond the API row limit', async () => {
  const native = globalThis.fetch
  const ids = Array.from({ length: 1001 }, (_, i) => String(i).padStart(4, '0'))
  const chunks: number[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname.endsWith('/roster_players')) {
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return Response.json(ids.slice(offset, offset + 1000).map(player_id => ({ player_id })))
    }
    const body = await request.json()
    assert.equal(body.p_limit, body.p_player_ids.length)
    assert.equal(body.p_offset, 0)
    chunks.push(body.p_player_ids.length)
    return Response.json(body.p_player_ids.map((player_id: string) => ({ player_id })))
  }
  try {
    const load = createScheduledProjectionLoader(client, [first])
    assert.deepEqual((await load(first, context, [ids[0], ids[1000]])).map(row => row.player_id), [ids[0], ids[1000]])
    assert.deepEqual(chunks, [1000, 1])
  } finally { globalThis.fetch = native }
})

Deno.test('a failed projection batch does not poison the next member or another league', async () => {
  const native = globalThis.fetch
  let projections = 0
  const leagues: string[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    if (url.pathname.endsWith('/roster_players')) {
      leagues.push(url.searchParams.get('league_id')!)
      return Response.json([{ player_id: 'a' }])
    }
    if (projections++ === 0) return Response.json({ message: 'unavailable', code: '57014' }, { status: 500 })
    return Response.json([{ player_id: 'a' }])
  }
  try {
    const other = { ...first, league_id: 'other' }
    const load = createScheduledProjectionLoader(client, [first, second, other])
    await assert.rejects(() => load(first, context, ['a']))
    assert.equal((await load(second, context, ['a'])).length, 1)
    assert.equal((await load(other, context, ['a'])).length, 1)
    assert.deepEqual(leagues, ['eq.league', 'eq.other'])
  } finally { globalThis.fetch = native }
})
