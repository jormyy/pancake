// Actual local scorer and health writes. Only the planning read receives a synthetic transport fault.
// The write failure comes from a task-owned SQL trigger; successful responses remain native.
import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL')!, db = Deno.env.get('SUPABASE_DB_URL')!
for (const endpoint of [api, db]) {
  assert.ok(
    endpoint && ['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname),
    'Only explicitly configured local services are allowed',
  )
}
const native = globalThis.fetch.bind(globalThis), token = crypto.randomUUID().replaceAll('-', '')
const leagues = [crypto.randomUUID(), crypto.randomUUID()], seasons = leagues.map(() => crypto.randomUUID())
const members = Array.from({ length: 4 }, () => crypto.randomUUID()),
  players = members.map(() => crypto.randomUUID())
const game = crypto.randomUUID(),
  weeks = Array.from({ length: 3 }, () => crypto.randomUUID()),
  users: string[] = []
const functionName = `e2e_score154_${token.slice(0, 12)}`, healthName = `e2e-score154-${token}`
let scoped = false, armed = false, phase = 'plan', hit = 0, year = 0, faultCreated = false
const requests: { phase: string; status: number }[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  assert.equal(url.origin, api, 'Only own local API receives requests')
  const method = init && 'method' in init ? init.method : (input instanceof Request ? input.method : 'GET')
  if (scoped && method === 'GET' && url.pathname.endsWith('/league_seasons')) {
    url.searchParams.set('league_id', `in.(${leagues.join(',')})`)
  }
  if (
    scoped && armed && phase === 'plan' && method === 'GET' && url.pathname.endsWith('/matchups') &&
    url.searchParams.get('league_id') === `eq.${leagues[0]}` &&
    url.searchParams.get('is_finalized') === 'eq.false'
  ) {
    armed = false
    hit++
    throw new Error('Synthetic C154 planning transport failure')
  }
  const response = await native(input instanceof Request ? new Request(url, input) : url, init)
  if (scoped && url.pathname.endsWith('/rpc/update_score_points_atomic')) {
    requests.push({ phase, status: response.status })
  }
  return response
}
const { supabase } = await import('../../functions/_shared/supabase.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const { recordSyncRun } = await import('../../functions/_shared/syncRuns.ts')
const q = async (operation: any): Promise<any> => {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`
async function sql(text: string) {
  const result = await new Deno.Command('psql', {
    args: [db, '-X', '-At', '--set', 'ON_ERROR_STOP=1', '-c', text],
    env: { PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000' },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
const day = (offset: number) =>
  new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10)
const state = () =>
  q(
    supabase.from('matchups').select('league_id,home_points,away_points,is_finalized,winner_member_id').in(
      'league_id',
      leagues,
    ).order('league_id'),
  )
let success = false
let runFailure: unknown
const cleanupErrors: Error[] = []
try {
  for (let n = 0; n < 50; n++) {
    const y = 8100 + crypto.getRandomValues(new Uint32Array(1))[0] % 800
    const used = await sql(
      `SELECT EXISTS(SELECT 1 FROM league_seasons WHERE season_year=${y}) OR EXISTS(SELECT 1 FROM season_weeks WHERE season_year=${y}) OR EXISTS(SELECT 1 FROM nba_games WHERE season_year=${y}) OR EXISTS(SELECT 1 FROM private.score_input_revisions WHERE scope='calendar:${y}' OR scope LIKE 'nba:${y}:%')`,
    )
    if (used === 'f') {
      year = y
      break
    }
  }
  assert.ok(year)
  for (let side = 0; side < 2; side++) {
    const u = await supabase.auth.admin.createUser({
      email: `score154-${token}-${side}@example.test`,
      password: `Synthetic-${crypto.randomUUID()}!`,
      email_confirm: true,
      user_metadata: { display_name: 'Synthetic partial score' },
    })
    if (u.error) throw u.error
    users.push(u.data.user.id)
  }
  await q(
    supabase.from('leagues').insert(
      leagues.map((id, i) => ({
        id,
        name: 'Synthetic partial score',
        slug: `score154-${token}-${i}`,
        commissioner_id: users[0],
        status: 'active' as const,
        scoring_settings: { points: 1 },
      })),
    ),
  )
  await q(
    supabase.from('league_members').insert(
      members.map((id, i) => ({
        id,
        league_id: leagues[Math.floor(i / 2)],
        user_id: users[i % 2],
        role: i % 2 ? 'manager' as const : 'commissioner' as const,
      })),
    ),
  )
  await q(
    supabase.from('league_seasons').insert(
      seasons.map((id, i) => ({ id, league_id: leagues[i], season_year: year, is_current: true })),
    ),
  )
  await q(
    supabase.from('season_weeks').insert(
      weeks.map((id, i) => ({
        id,
        season_year: year,
        week_number: i + 1,
        week_start: day(-14 + i * 7),
        week_end: day(-8 + i * 7),
      })),
    ),
  )
  await q(
    supabase.from('players').insert(
      players.map((id, i) => ({
        id,
        first_name: 'Synthetic',
        last_name: `Partial154 ${token} ${i}`,
        position: 'PG' as const,
        eligible_positions: ['PG'],
        nba_team: 'XSA',
      })),
    ),
  )
  await q(
    supabase.from('roster_players').insert(
      players.map((player_id, i) => ({
        player_id,
        member_id: members[i],
        league_id: leagues[Math.floor(i / 2)],
        league_season_id: seasons[Math.floor(i / 2)],
        acquired_via: 'draft',
        acquired_at: `${day(-21)}T12:00:00Z`,
      })),
    ),
  )
  await q(
    supabase.from('nba_games').insert({
      id: game,
      nba_game_id: `002-score154-${token}`,
      season_year: year,
      week_number: 1,
      game_date: day(-12),
      home_team: 'XSA',
      away_team: 'XSB',
      status: 'Final',
      stats_synced_at: new Date().toISOString(),
    }),
  )
  await q(
    supabase.from('player_game_stats').insert(
      players.map((player_id, i) => ({
        player_id,
        game_id: game,
        season_year: year,
        week_number: 1,
        game_date: day(-12),
        points: i % 2 ? 20 : 10,
        did_not_play: false,
      })),
    ),
  )
  await q(
    supabase.from('weekly_lineups').insert(
      players.map((player_id, i) => ({
        player_id,
        member_id: members[i],
        league_id: leagues[Math.floor(i / 2)],
        league_season_id: seasons[Math.floor(i / 2)],
        game_date: day(-12),
        week_number: 1,
        slot_type: 'PG' as const,
        is_auto_set: false,
      })),
    ),
  )
  await q(
    supabase.from('matchups').insert(
      leagues.map((league_id, i) => ({
        league_id,
        league_season_id: seasons[i],
        week_number: 1,
        home_member_id: members[i * 2],
        away_member_id: members[i * 2 + 1],
        matchup_type: 'regular_season' as const,
        home_points: 99,
        away_points: 98,
      })),
    ),
  )
  const requestedPhase = Deno.args.find((a) => a.startsWith('--phase='))?.split('=')[1]
  assert.ok(!requestedPhase || ['plan', 'write'].includes(requestedPhase))
  for (phase of requestedPhase ? [requestedPhase] : ['plan', 'write']) {
    if (phase === 'write') {
      await q(
        supabase.from('matchups').update({
          home_points: 99,
          away_points: 98,
          is_finalized: false,
          finalized_at: null,
          winner_member_id: null,
        }).in('league_id', leagues),
      )
      await sql(
        `CREATE FUNCTION private.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.league_id=${
          literal(leagues[0])
        }::uuid THEN RAISE EXCEPTION 'Synthetic C154 score write failure'; END IF; RETURN NEW; END$$; CREATE TRIGGER ${functionName} BEFORE UPDATE ON public.matchups FOR EACH ROW EXECUTE FUNCTION private.${functionName}();`,
      )
      faultCreated = true
    }
    scoped = true
    armed = true
    let failure: unknown
    try {
      await recordSyncRun(healthName + '-' + phase, async () => {
        await syncScores()
        return { result: undefined, rowsAffected: null }
      })
    } catch (e) {
      failure = e
    }
    armed = false
    scoped = false
    const rows = await state(),
      health = await q(
        supabase.from('sync_runs').select('status,error').eq('function_name', healthName + '-' + phase)
          .single(),
      )
    const broken = rows.find((r: any) => r.league_id === leagues[0]),
      healthy = rows.find((r: any) => r.league_id === leagues[1])
    console.log(
      JSON.stringify({
        phase,
        planningFaults: hit,
        actualWriteStatuses: requests.filter((r) => r.phase === phase),
        rows,
        health,
        threw: failure !== undefined,
        causes: failure instanceof AggregateError ? failure.errors.map(String) : [],
      }),
    )
    if (phase === 'plan') assert.equal(hit, 1)
    if (phase === 'write') {
      assert.deepEqual(requests.filter((r) => r.phase === phase).map((r) => r.status).sort(), [200, 400])
    }
    assert.equal(broken.is_finalized, false)
    assert.equal(Number(broken.away_points), 98)
    assert.equal(Number(broken.home_points), 99)
    assert.equal(Number(healthy.home_points), 10)
    assert.equal(Number(healthy.away_points), 20)
    assert.equal(healthy.is_finalized, true)
    assert.equal(health.status, 'failed', 'A failed season must not make sync health claim success')
    assert.ok(health.error)
    assert.ok(failure instanceof AggregateError, 'The caller must see incomplete scoring')
    assert.equal(failure.errors.length, 1)
    assert.ok(failure.errors[0] instanceof Error)
    assert.ok(
      failure.errors[0].message.includes(
        phase === 'plan' ? 'Synthetic C154 planning transport failure' : 'Synthetic C154 score write failure',
      ),
      'The injected failure must reach the caller',
    )
    if (faultCreated) {
      await sql(`DROP TRIGGER ${functionName} ON public.matchups;DROP FUNCTION private.${functionName}();`)
      faultCreated = false
    }
  }
  await recordSyncRun(healthName + '-retry', async () => {
    scoped = true
    try {
      await syncScores()
    } finally {
      scoped = false
    }
    return { result: undefined, rowsAffected: null }
  })
  const final = await state()
  assert.ok(
    final.every((r: any) => Number(r.home_points) === 10 && Number(r.away_points) === 20 && r.is_finalized),
  )
  const health = await q(
    supabase.from('sync_runs').select('status').eq('function_name', healthName + '-retry').single(),
  )
  assert.equal(health.status, 'success')
  console.log(JSON.stringify({ phase: 'restored-retry', rows: final, health }))
  success = true
} catch (error) {
  runFailure = error
} finally {
  scoped = false
  armed = false
  globalThis.fetch = native
  const clean = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      cleanupErrors.push(new Error(`${label}: ${String(error)}`, { cause: error }))
    }
  }
  await clean('fault trigger', () => sql(`DROP TRIGGER IF EXISTS ${functionName} ON public.matchups;`))
  await clean('fault function', () => sql(`DROP FUNCTION IF EXISTS private.${functionName}();`))
  await clean('leagues', () => q(supabase.from('leagues').delete().in('id', leagues)))
  await clean('stats', () => q(supabase.from('player_game_stats').delete().eq('game_id', game)))
  await clean('game', () => q(supabase.from('nba_games').delete().eq('id', game)))
  await clean('players', () => q(supabase.from('players').delete().in('id', players)))
  await clean('weeks', () => q(supabase.from('season_weeks').delete().in('id', weeks)))
  await clean('health', () =>
    q(
      supabase.from('sync_runs').delete().in(
        'function_name',
        ['plan', 'write', 'retry'].map((p) => healthName + '-' + p),
      ),
    ))
  for (const id of users) {
    await clean('user', async () => {
      const d = await supabase.auth.admin.deleteUser(id)
      if (d.error) throw d.error
    })
  }
  const keys = [
    ...players.map((id) => 'player:' + id),
    ...(year ? ['calendar:' + year, ...[1, 2, 3].map((w) => `nba:${year}:${w}`)] : []),
    ...leagues.map((l) => 'league:' + l),
    ...seasons.flatMap(
      (s) => ['season:' + s, ...[1, 2, 3].flatMap((w) => [`lineup:${s}:${w}`, `result:${s}:${w}`])],
    ),
  ]
  await clean(
    'revisions',
    () => sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${keys.map(literal).join(',')});`),
  )
  await clean('fault absence', async () => {
    assert.equal(await sql(`SELECT count(*) FROM pg_proc WHERE proname=${literal(functionName)}`), '0')
  })
  await clean('fixture absence', async () =>
    assert.equal(
      await sql(
        `SELECT (SELECT count(*) FROM leagues WHERE id IN (${
          leagues.map(literal).join(',')
        }))+(SELECT count(*) FROM players WHERE id IN (${
          players.map(literal).join(',')
        }))+(SELECT count(*) FROM nba_games WHERE id=${literal(game)})`,
      ),
      '0',
    ))
  console.log(JSON.stringify({
    cleanupErrors: cleanupErrors.map(String),
    nativeFetchRestored: globalThis.fetch === native,
    fixtureAndFaultAbsence: cleanupErrors.length === 0,
    success,
    runFailure: runFailure === undefined ? null : String(runFailure),
  }))
}
if (cleanupErrors.length) {
  throw new AggregateError(
    [...(runFailure === undefined ? [] : [runFailure]), ...cleanupErrors],
    'Scoring fixture cleanup failed',
  )
}
if (runFailure !== undefined) throw runFailure
