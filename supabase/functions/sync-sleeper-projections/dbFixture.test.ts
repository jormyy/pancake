import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2'
import type { Database } from '../_shared/database.ts'
import { syncSleeperProjections } from './sync.ts'


Deno.test({ name: 'recorded Sleeper pulls update in place and preserve rows on failed requests', ignore: !Deno.args.includes('--local-db'), fn: async () => {
  const api = Deno.env.get('SUPABASE_URL')!
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')
  assert.ok(key)
  const client = createClient<Database>(api, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-1.json', import.meta.url)))
  const context = { seasonYear: 2027, weekNumber: 1, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }
  const ids = fixture.map(() => crypto.randomUUID())
  const league = crypto.randomUUID()
  let user: string | null = null
  const runs: string[] = []
  const query = async <T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
  }
  const pull = async (value: unknown, status = 200) => {
    try { return await syncSleeperProjections(client, context, () => Promise.resolve(Response.json(value, { status }))) }
    finally {
      const data = await query(client.from('projection_sync_runs').select('id').eq('source', 'sleeper').eq('season_year', 2027))
      assert.ok(data)
      runs.push(...data.map((r) => r.id).filter((id) => !runs.includes(id)))
    }
  }
  try {
    const { data, error } = await client.auth.admin.createUser({ email: `${league}@example.test`, password: `Local-${league}!`, email_confirm: true,
      user_metadata: { username: `sleeper_${league.slice(0, 8)}` } })
    if (error) throw error
    user = data.user.id
    await query(client.from('leagues').insert({ id: league, name: 'Sleeper recorded fixture', slug: league, commissioner_id: user, scoring_settings: { points: 1 }, status: 'active' }))
    await query(client.from('players').insert(fixture.map((r: { player_id: string; player: { first_name: string; last_name: string }; team: string }, i: number) => ({
      id: ids[i], sleeper_id: r.player_id, first_name: r.player.first_name, last_name: r.player.last_name, nba_team: r.team, position: 'PG',
    }))))
    const first = await pull(fixture)
    assert.equal(first?.rows, 3)
    const initial = await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id'))
    assert.ok(initial)
    const changed = structuredClone(fixture)
    for (const row of changed) { row.stats.pts += 1; row.last_modified += 1000 }
    await pull(changed)
    const second = await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id'))
    assert.ok(second)
    assert.equal(second.length, 3)
    assert.deepEqual(second.map((r) => r.id), initial.map((r) => r.id))
    for (let i = 0; i < 3; i++) assert.equal(second[i].points, initial[i].points + 1)
    for (const response of [{ value: {}, status: 200 }, { value: { error: 'unavailable' }, status: 503 }]) {
      await assert.rejects(() => pull(response.value, response.status))
    }
    assert.deepEqual(await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id')), second)
    const read = await query(client.rpc('get_league_projection_rows', { p_league_id: league, p_season_year: 2027,
      p_game_date: '2026-10-20', p_view: 'today', p_player_ids: ids }))
    assert.ok(read)
    assert.equal(read.length, 3)
    assert.ok(read.every((r) => r.projection_source === 'sleeper'))
    for (const row of read) assert.equal(row.projection_points, changed[ids.indexOf(row.player_id)].stats.pts)
    const attempts = await query(client.from('projection_sync_runs').select('status').in('id', runs))
    assert.ok(attempts)
    assert.equal(attempts.filter((r) => r.status === 'failed').length, 2)
    console.log(JSON.stringify({ passed: 8, playerGames: initial.length, secondPullPlayerGames: second.length, reader: 'sleeper', failedPullsPreserveRows: true, externalRequests: 0 }))
  } finally {
    if (runs.length) await query(client.from('projection_sync_runs').delete().in('id', runs))
    await query(client.from('leagues').delete().eq('id', league))
    await query(client.from('players').delete().in('id', ids))
    if (user) { const { error } = await client.auth.admin.deleteUser(user); if (error) throw error }
  }
} })
