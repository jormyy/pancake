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
  const sample = JSON.parse(await Deno.readTextFile(new URL('./fixtures/matched-sample.json', import.meta.url)))
  const week = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-1.json', import.meta.url)))
  const sit = week.find((row: { player_id: string; date: string }) => row.player_id === '1946' && row.date === '2026-10-20')
  assert.ok(sit)
  const fixture = [...sample, sit]
  const context = { seasonYear: 2027, weekNumber: 1, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }
  const ids: string[] = fixture.map(() => crypto.randomUUID())
  const league = crypto.randomUUID()
  let user: string | null = null
  const runs: string[] = []
  const games: string[] = []
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
    await query(client.from('players').insert(fixture.map((r: { player_id: string; player: { first_name: string; last_name: string }; team: string }, i: number): Database['public']['Tables']['players']['Insert'] => ({
      id: ids[i], sleeper_id: r.player_id, first_name: r.player.first_name, last_name: r.player.last_name, nba_team: r.team, position: 'PG',
    }))))
    const pairs = new Map<string, { date: string; team: string; opponent: string }>()
    for (const row of fixture) pairs.set(`${row.date}:${[row.team, row.opponent].sort().join(':')}`, row)
    for (const [i, row] of [...pairs.values()].entries()) {
      const game = `0029709${String(i).padStart(3, '0')}`
      await query(client.from('nba_games').insert({ nba_game_id: game, season_year: 2027, week_number: 1, game_date: row.date,
        game_time: `${row.date}T23:00:00Z`, home_team: row.team, away_team: row.opponent, status: 'Scheduled' }))
      games.push(game)
    }
    const backup = crypto.randomUUID()
    runs.push(backup)
    await query(client.from('projection_sync_runs').insert({ id: backup, source: 'fantasypros', projection_type: 'daily', source_url: 'https://www.fantasypros.com/nba/projections/daily-overall.php', season_year: 2027, projection_date: '2026-10-20' }))
    await query(client.from('fantasypros_projection_rows').insert({ run_id: backup, projection_type: 'daily', source_url: 'https://www.fantasypros.com/nba/projections/daily-overall.php', source_row_number: 1, season_year: 2027, projection_date: '2026-10-20', fetched_at: new Date().toISOString(), source_player_name: 'Projected sit', normalized_player_name: 'projected sit', player_id: ids[3], match_status: 'matched', points: 100 }))
    await query(client.from('projection_sync_runs').update({ status: 'success', completed_at: new Date().toISOString() }).eq('id', backup))
    const first = await pull(fixture)
    assert.equal(first?.rows, 4)
    const initial = await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id'))
    assert.ok(initial)
    const changed = structuredClone(fixture)
    for (const row of changed) { if (row.stats.gp) row.stats.pts += 1; row.last_modified += 1000 }
    await pull(changed)
    const second = await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id'))
    assert.ok(second)
    assert.equal(second.length, 4)
    assert.deepEqual(second.map((r) => r.id), initial.map((r) => r.id))
    for (let i = 0; i < 4; i++) assert.equal(second[i].points, initial[i].points + (fixture[ids.indexOf(second[i].player_id)].stats.gp ? 1 : 0))
    for (const response of [{ value: {}, status: 200 }, { value: { error: 'unavailable' }, status: 503 }]) {
      await assert.rejects(() => pull(response.value, response.status))
    }
    assert.deepEqual(await query(client.from('sleeper_projection_rows').select('id,player_id,points').in('player_id', ids).order('player_id')), second)
    const read = await query(client.rpc('get_league_projection_rows', { p_league_id: league, p_season_year: 2027,
      p_game_date: '2026-10-20', p_view: 'today', p_player_ids: ids }))
    assert.ok(read)
    assert.equal(read.length, 4)
    assert.ok(read.every((r) => r.projection_source === 'sleeper'))
    for (const row of read) assert.equal(row.projection_points, (changed[ids.indexOf(row.player_id)].stats.pts ?? 0))
    assert.equal(read.find((row) => row.player_id === ids[3])?.projection_points, 0)
    assert.equal(read.find((row) => row.player_id === ids[3])?.projection_fantasy_points, 0)
    const attempts = await query(client.from('projection_sync_runs').select('status').in('id', runs))
    assert.ok(attempts)
    assert.equal(attempts.filter((r) => r.status === 'failed').length, 2)
    console.log(JSON.stringify({ passed: 10, projectedSitBeatsBackup: true, playerGames: initial.length, secondPullPlayerGames: second.length, reader: 'sleeper', failedPullsPreserveRows: true, externalRequests: 0 }))
  } finally {
    if (runs.length) await query(client.from('projection_sync_runs').delete().in('id', runs))
    await query(client.from('leagues').delete().eq('id', league))
    await query(client.from('players').delete().in('id', ids))
    if (games.length) await query(client.from('nba_games').delete().in('nba_game_id', games))
    if (user) { const { error } = await client.auth.admin.deleteUser(user); if (error) throw error }
  }
} })
