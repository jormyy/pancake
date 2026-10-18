import { strict as assert } from 'node:assert'
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database } from '../../../types/database.ts'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!
const publicKey = Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')!
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient<Database>(api, key, options)
const league = crypto.randomUUID(), season = crypto.randomUUID(), game = crypto.randomUUID()
const scope = crypto.randomUUID().replaceAll('-', '')
const year = 10000 + Math.floor(Math.random() * 10000)
const date = '2040-01-01'
const users: string[] = [], players: string[] = [], weeks: string[] = []
const projectionRuns: string[] = []
const members = Array.from({ length: 3 }, () => crypto.randomUUID())
const clients: ReturnType<typeof createClient<Database>>[] = []
const channels: { client: ReturnType<typeof createClient<Database>>; channel: ReturnType<ReturnType<typeof createClient<Database>>['channel']> }[] = []
const messages = Array.from({ length: 5 }, () => [] as Record<string, unknown>[])
let checks = 0
async function q<T>(operation: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await operation
  if (error) throw new Error(error.message)
  return data
}
async function sql(command: string, expected = 0) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-c', command], stdin: 'null', stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, expected, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function hint(topic: string) {
  const marker = await q(admin.from('league_change_hints').select('*').eq('league_id', league).eq('topic', topic).single())
  assert.ok(marker)
  return marker
}
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const until = Date.now() + 15000
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
  throw new Error(label)
}
async function join(client: ReturnType<typeof createClient<Database>>, side: number) {
  const channel = client.channel(`owned-hints-${scope}-${side}`, { config: { private: true } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'league_change_hints', filter: `league_id=eq.${league}` }, payload => {
      if (payload.eventType !== 'DELETE') messages[side].push(payload.new)
    })
  channels.push({ client, channel })
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No actual Realtime join outcome')), 15000)
    channel.subscribe(status => {
      if (['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT'].includes(status)) { clearTimeout(timeout); resolve(status) }
    })
  })
}
try {
  const password = `Owned-${crypto.randomUUID()}!`
  for (let side = 0; side < 4; side++) {
    const email = `hints-${scope}-${side}@example.com`
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `hint_${scope.slice(0, 14)}_${side}` } })
    if (created.error) throw created.error
    assert.ok(created.data.user); users.push(created.data.user.id)
    const client = createClient<Database>(api, publicKey, options)
    const login = await client.auth.signInWithPassword({ email, password })
    if (login.error) throw login.error
    clients.push(client)
  }
  const anon = createClient<Database>(api, publicKey, options)
  clients.push(anon)
  await q(admin.from('leagues').insert({ id: league, name: 'Owned compact hints', slug: scope, commissioner_id: users[0], status: 'active', roster_size: 30 }))
  await q(admin.from('league_members').insert(members.map((id, side) => ({ id, league_id: league, user_id: users[side], role: side === 0 ? 'commissioner' as const : 'manager' as const, team_name: `Hints ${side}` }))))
  await q(admin.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  const weekRows = await q(admin.from('season_weeks').insert(Array.from({ length: 7 }, (_, index) => ({ season_year: year, week_number: index + 1,
    week_start: new Date(Date.UTC(2040, 0, 1 + index * 7)).toISOString().slice(0, 10),
    week_end: new Date(Date.UTC(2040, 0, 7 + index * 7)).toISOString().slice(0, 10) }))).select('id'))
  assert.ok(weekRows)
  weeks.push(...weekRows.map(row => row.id))
  const rows = await q(admin.from('players').insert(Array.from({ length: 20 }, (_, index) => ({ first_name: 'Owned', last_name: `${scope} ${index}`, nba_team: 'NYK', position: 'PG' as const, eligible_positions: ['PG' as const], years_exp: 1 }))).select('id'))
  assert.ok(rows)
  players.push(...rows.map(row => row.id))
  await q(admin.from('roster_players').insert(players.map(player_id => ({ league_id: league, league_season_id: season, member_id: members[0], player_id, acquired_via: 'draft' }))))
  const rosterHint = await hint('roster')
  assert.equal(rosterHint.revision, 1)
  assert.deepEqual(rosterHint.scopes, [{ season_id: season, member_id: members[0] }]); checks += 2
  const resourceMarkers = await q(admin.from('league_change_hints').select('topic').eq('league_id', league).eq('topic', 'resources'))
  assert.deepEqual({ inventory: Reflect.get(await hint('inventory'), 'details'), resources: resourceMarkers?.length },
    { inventory: [{ resource: 'season', season_id: season }], resources: 1 })
  checks++
  assert.equal(await join(clients[0], 0), 'SUBSCRIBED')
  assert.equal(await join(clients[1], 1), 'SUBSCRIBED')
  assert.equal(await join(clients[2], 2), 'SUBSCRIBED')
  await join(clients[3], 3); await join(anon, 4)
  await q(admin.from('weekly_lineups').insert(players.map(player_id => ({ league_id: league, league_season_id: season, member_id: members[0], player_id, game_date: date, week_number: 1, slot_type: 'BE' as const }))))
  let marker = await hint('lineup')
  assert.equal(marker.revision, 1)
  assert.deepEqual(marker.scopes, [{ date, season_id: season, member_id: members[0] }])
  await waitFor(() => messages[0].some(row => row.topic === 'lineup' && row.revision === 1), 'Commissioner misses the compact bulk change')
  await waitFor(() => messages[1].some(row => row.topic === 'lineup' && row.revision === 1), 'Manager misses the compact bulk change')
  await waitFor(() => messages[2].some(row => row.topic === 'lineup' && row.revision === 1), 'Future removed member never joins')
  assert.equal(messages[0].filter(row => row.topic === 'lineup').length, 1)
  for (const message of messages[0]) assert.ok(!JSON.stringify(message).includes(players[0]))
  checks += 5
  await q(admin.from('weekly_lineups').update({ is_auto_set: true }).eq('league_id', league))
  assert.equal((await hint('lineup')).revision, 2)
  await q(admin.from('weekly_lineups').update({ is_auto_set: true, set_at: new Date().toISOString() }).eq('league_id', league))
  assert.equal((await hint('lineup')).revision, 2); checks += 2
  await q(admin.from('weekly_lineups').update({ game_date: '2040-01-02' }).eq('league_id', league).eq('player_id', players[0]))
  marker = await hint('lineup')
  assert.equal(marker.revision, 3)
  assert.deepEqual((marker.scopes as { date: string }[]).map(row => row.date).sort(), [date, '2040-01-02']); checks += 2
  await q(admin.from('weekly_lineups').delete().eq('league_id', league).eq('player_id', players[0]))
  assert.equal((await hint('lineup')).revision, 4); checks++
  const beforeRollback = await hint('lineup')
  await sql(`BEGIN; UPDATE weekly_lineups SET is_auto_set=false WHERE league_id='${league}'; ROLLBACK`)
  assert.deepEqual(await hint('lineup'), beforeRollback)
  await sql(`BEGIN; UPDATE weekly_lineups SET is_auto_set=false WHERE league_id='${league}'; INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES('${league}','${season}','${members[0]}','${crypto.randomUUID()}','draft'); COMMIT`, 1)
  assert.deepEqual(await hint('lineup'), beforeRollback); checks += 2
  const updates = players.slice(1, 3).map((id, index) => sql(`SET application_name='hint-race-${scope}-${index}'; BEGIN; UPDATE weekly_lineups SET is_auto_set=false WHERE league_id='${league}' AND player_id='${id}'; SELECT pg_sleep(0.5); COMMIT`))
  await waitFor(async () => Number(await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'hint-race-${scope}-%' AND cardinality(pg_blocking_pids(pid))>0`)) > 0, 'The two actual marker upserts never overlap')
  await Promise.all(updates)
  assert.equal((await hint('lineup')).revision, 6); checks++
  await q(admin.from('weekly_lineups').insert(Array.from({ length: 17 }, (_, index) => ({ league_id: league, league_season_id: season, member_id: members[0], player_id: players[0], game_date: `2040-02-${String(index + 1).padStart(2, '0')}`, week_number: Math.floor((31 + index) / 7) + 1, slot_type: 'BE' as const }))))
  assert.equal((await hint('lineup')).scopes, null); checks++
  await q(admin.from('nba_games').insert({ id: game, nba_game_id: `002-${scope}`, season_year: year, week_number: 1, game_date: date, home_team: 'NYK', away_team: 'BOS', status: 'InProgress' }))
  assert.equal((await hint('game')).revision, 1)
  await q(admin.from('player_game_stats').insert(players.map(player_id => ({ game_id: game, player_id, season_year: year, week_number: 1, game_date: date, points: 7 }))))
  assert.equal((await hint('stat')).revision, 1)
  await q(admin.from('player_game_stats').update({ points: 4 }).eq('game_id', game))
  assert.equal((await hint('stat')).revision, 2)
  await q(admin.from('player_game_stats').update({ points: 4, updated_at: new Date().toISOString() }).eq('game_id', game))
  assert.equal((await hint('stat')).revision, 2); checks += 4
  await q(admin.from('matchups').insert({ league_id: league, league_season_id: season, week_number: 1, home_member_id: members[0], away_member_id: members[1], home_points: 10, away_points: 7 }))
  assert.equal((await hint('score')).revision, 1)
  await q(admin.from('matchups').update({ home_points: 3 }).eq('league_id', league))
  assert.equal((await hint('score')).revision, 2); checks += 2
  await q(admin.from('league_seasons').update({ is_current: false }).eq('id', season))
  await q(admin.from('roster_players').delete().eq('league_id', league).eq('player_id', players[3]))
  await q(admin.from('player_game_stats').update({ points: 3 }).eq('game_id', game).eq('player_id', players[3]))
  assert.equal((await hint('stat')).revision, 3)
  assert.deepEqual((await hint('stat')).scopes, [{ date, season_id: season }]); checks += 2
  await q(admin.from('league_seasons').update({ is_current: true }).eq('id', season))
  const inventoryBefore = await hint('inventory')
  assert.deepEqual(Reflect.get(inventoryBefore, 'details'), [{ resource: 'season', season_id: season }]); checks++
  const pick = crypto.randomUUID()
  await q(admin.from('draft_picks').insert({ id: pick, league_id: league, original_owner_id: members[0], current_owner_id: members[0], season_year: year + 1, round: 1 }))
  assert.equal((await hint('inventory')).revision, inventoryBefore.revision + 1)
  assert.equal(Reflect.get(await hint('inventory'), 'details'), null); checks++
  await q(admin.from('draft_picks').update({ current_owner_id: members[1] }).eq('id', pick))
  assert.equal((await hint('inventory')).revision, inventoryBefore.revision + 2)
  await q(admin.from('draft_picks').update({ current_owner_id: members[1] }).eq('id', pick))
  assert.equal((await hint('inventory')).revision, inventoryBefore.revision + 2)
  await q(admin.from('draft_picks').delete().eq('id', pick))
  assert.equal((await hint('inventory')).revision, inventoryBefore.revision + 3)
  await q(admin.from('draft_picks').insert({ id: pick, league_id: league, original_owner_id: members[0], current_owner_id: members[0], season_year: year, round: 1 }))
  assert.deepEqual(Reflect.get(await hint('inventory'), 'details'), [{ resource: 'picks', season_id: season, member_id: members[0] }])
  await q(admin.from('draft_picks').update({ current_owner_id: members[1] }).eq('id', pick))
  assert.deepEqual(Reflect.get(await hint('inventory'), 'details'),
    [members[0], members[1]].sort().map(member_id => ({ resource: 'picks', season_id: season, member_id })))
  await q(admin.from('draft_picks').delete().eq('id', pick))
  assert.deepEqual(Reflect.get(await hint('inventory'), 'details'), [{ resource: 'picks', season_id: season, member_id: members[1] }]); checks += 3
  for (const [table, details] of [
    ['waiver_claims', { player_id: players[3], priority_at_submission: 1, process_date: date }],
    ['waiver_priorities', { priority: 1 }],
    ['waiver_wire_log', { player_id: players[3], clears_at: '2040-01-03T00:00:00Z' }],
    ['faab_balances', { balance: 100 }],
  ] as const) {
    if (table === 'faab_balances') await q(admin.from(table).delete().eq('league_id', league).eq('member_id', members[0]))
    const before = await hint('inventory'), id = crypto.randomUUID()
    const row = { id, league_id: league, league_season_id: season, member_id: members[0], ...details }
    const wire = table === 'waiver_wire_log' ? { id, league_id: league, league_season_id: season, ...details } : row
    await sql(`INSERT INTO public.${table} (${Object.keys(wire).join(',')}) VALUES (${Object.values(wire).map(value => typeof value === 'number' ? value : `'${value}'`).join(',')})`)
    assert.equal((await hint('inventory')).revision, before.revision + 1, `${table} insert`)
    const resource = { waiver_claims: 'claims', waiver_priorities: 'priority', waiver_wire_log: 'waivers', faab_balances: 'faab' }[table]
    const detail = { resource, season_id: season, ...(['priority', 'faab'].includes(resource) ? { member_id: members[0] } : {}) }
    assert.deepEqual(Reflect.get(await hint('inventory'), 'details'), [detail])
    if (resource === 'priority' || resource === 'claims') {
      await waitFor(() => messages[1].some(row => row.topic === 'inventory' && row.revision === before.revision + 1), `${resource} detail misses the other manager`)
      assert.deepEqual(Reflect.get(messages[1].find(row => row.topic === 'inventory' && row.revision === before.revision + 1)!, 'details'), [detail]); checks++
    }
    if (table === 'waiver_claims') {
      assert.deepEqual(await q(clients[1].from('waiver_claims').select('id').eq('id', id)), [])
      assert.ok(!JSON.stringify(await hint('inventory')).includes(members[0])); checks += 2
    }
    await q(admin.from(table).delete().eq('id', id))
    assert.equal((await hint('inventory')).revision, before.revision + 2, `${table} delete`)
    assert.deepEqual(Reflect.get(await hint('inventory'), 'details'), [detail])
    checks += 4
  }
  const extraSeasons = Array.from({ length: 17 }, (_, index) => ({ id: crypto.randomUUID(), league_id: league, season_year: year + index + 1, is_current: false }))
  await q(admin.from('league_seasons').insert(extraSeasons))
  assert.equal(Reflect.get(await hint('inventory'), 'details'), null)
  await q(admin.from('leagues').update({ scoring_settings: { points: 2 } }).eq('id', league))
  assert.equal(Reflect.get(await hint('resources'), 'details'), null); checks++
  await q(admin.from('league_seasons').delete().in('id', extraSeasons.map(row => row.id)))
  assert.equal(Reflect.get(await hint('inventory'), 'details'), null); checks += 2
  const resourcesBeforeLive = await hint('resources')
  await q(admin.from('player_game_stats').update({ points: 5 }).eq('game_id', game))
  assert.deepEqual(await hint('resources'), resourcesBeforeLive)
  await sql('SELECT public.refresh_player_search_caches()')
  const firstRefresh = await hint('resources')
  assert.equal(firstRefresh.revision, resourcesBeforeLive.revision + 1)
  assert.deepEqual(Reflect.get(firstRefresh, 'details'), [{ resource: 'averages', season_id: season }])
  await sql('SELECT public.refresh_player_search_caches()')
  assert.deepEqual(await hint('resources'), firstRefresh)
  await q(admin.from('player_game_stats').update({ points: 6 }).eq('game_id', game))
  assert.deepEqual(await hint('resources'), firstRefresh)
  await sql('SELECT public.refresh_player_search_caches()')
  assert.equal((await hint('resources')).revision, firstRefresh.revision + 1); checks += 6
  const beforeScoring = await hint('resources')
  await q(admin.from('leagues').update({ scoring_settings: { points: 3 } }).eq('id', league))
  assert.equal((await hint('resources')).revision, beforeScoring.revision + 1)
  assert.deepEqual(Reflect.get(await hint('resources'), 'details'), [{ resource: 'scoring', season_id: season }])
  const afterScoring = await hint('resources')
  await q(admin.from('leagues').update({ scoring_settings: { points: 3 }, name: 'Owned hints renamed' }).eq('id', league))
  assert.deepEqual(await hint('resources'), afterScoring)
  await sql(`BEGIN; UPDATE public.leagues SET scoring_settings='{"points":4}' WHERE id='${league}'; ROLLBACK`)
  assert.deepEqual(await hint('resources'), afterScoring); checks += 4
  const projection = crypto.randomUUID()
  await q(admin.from('player_projections').insert({ id: projection, player_id: players[0], season_year: year, week_number: 1, projected_points: 12 }))
  assert.equal((await hint('resources')).revision, afterScoring.revision + 1)
  assert.deepEqual(Reflect.get(await hint('resources'), 'details'), [{ resource: 'projections', season_id: season }])
  const beforeProjectionNoop = await hint('resources')
  await q(admin.from('player_projections').update({ projected_points: 12 }).eq('id', projection))
  assert.deepEqual(await hint('resources'), beforeProjectionNoop)
  await q(admin.from('player_projections').delete().eq('id', projection))
  assert.equal((await hint('resources')).revision, beforeProjectionNoop.revision + 1); checks += 4
  const concurrentProjections = players.slice(0, 2).map(player_id => ({ id: crypto.randomUUID(), player_id, season_year: year, week_number: 2, projected_points: 12 }))
  await q(admin.from('player_projections').insert(concurrentProjections))
  const beforeResourceRace = await hint('resources')
  const resourceUpdates = concurrentProjections.map((row, index) => sql(`SET application_name='resource-race-${scope}-${index}'; BEGIN; UPDATE public.player_projections SET projected_points=13 WHERE id='${row.id}'; SELECT pg_sleep(0.5); COMMIT`))
  await waitFor(async () => Number(await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'resource-race-${scope}-%' AND cardinality(pg_blocking_pids(pid))>0`)) > 0, 'Resource upserts never overlap')
  await Promise.all(resourceUpdates)
  assert.equal((await hint('resources')).revision, beforeResourceRace.revision + 2)
  await q(admin.from('player_projections').delete().in('id', concurrentProjections.map(row => row.id))); checks++
  const run = crypto.randomUUID(), sourceUrl = 'https://www.fantasypros.com/nba/projections/daily-overall.php'
  projectionRuns.push(run)
  const beforeRun = await hint('resources')
  await q(admin.from('projection_sync_runs').insert({ id: run, source_url: sourceUrl, projection_type: 'daily', season_year: year, projection_date: date }))
  await q(admin.from('fantasypros_projection_rows').insert({ run_id: run, projection_type: 'daily', source_url: sourceUrl, source_row_number: 1, season_year: year, projection_date: date,
    fetched_at: new Date().toISOString(), source_player_name: 'Owned player', normalized_player_name: 'owned player', player_id: players[0], match_status: 'matched', points: 12 }))
  assert.deepEqual(await hint('resources'), beforeRun)
  await q(admin.from('projection_sync_runs').update({ status: 'success', completed_at: new Date().toISOString() }).eq('id', run))
  assert.equal((await hint('resources')).revision, beforeRun.revision + 1)
  await q(admin.from('fantasypros_projection_rows').update({ points: 15 }).eq('run_id', run))
  assert.equal((await hint('resources')).revision, beforeRun.revision + 2)
  await q(admin.from('projection_sync_runs').update({ status: 'failed' }).eq('id', run))
  assert.equal((await hint('resources')).revision, beforeRun.revision + 3)
  await q(admin.from('projection_sync_runs').delete().eq('id', run))
  assert.equal((await hint('resources')).revision, beforeRun.revision + 4); checks += 5
  const lastResource = await hint('resources')
  await waitFor(() => messages[1].some(row => row.topic === 'resources' && row.revision === lastResource.revision)
    && messages[2].some(row => row.topic === 'resources' && row.revision === lastResource.revision), 'Resource revision is not delivered')
  assert.equal(lastResource.scopes, null)
  for (const row of messages[1]) {
    const details = Reflect.get(row, 'details')
    if (Array.isArray(details)) {
      assert.ok(details.length <= 16 && JSON.stringify(details).length <= 4096)
      for (const detail of details) assert.ok(Object.keys(detail).every(key => ['resource', 'season_id', 'member_id'].includes(key)))
    }
    for (const player of players) assert.ok(!JSON.stringify(row).includes(player))
  }
  checks += 3
  const inventoryRollback = await hint('inventory')
  await sql(`BEGIN; UPDATE league_seasons SET is_current=false WHERE id='${season}'; ROLLBACK`)
  assert.deepEqual(await hint('inventory'), inventoryRollback)
  assert.equal((await hint('inventory')).scopes, null)
  await waitFor(() => messages[1].some(row => row.topic === 'inventory' && row.revision === inventoryRollback.revision) && messages[2].some(row => row.topic === 'inventory' && row.revision === inventoryRollback.revision), 'Inventory hint is not delivered')
  checks += 7
  const lastStat = await hint('stat')
  await waitFor(() => messages[2].some(row => row.topic === 'stat' && row.revision === lastStat.revision), 'Member misses the last pre-removal event')
  const removedCount = messages[2].length
  await q(admin.from('league_members').delete().eq('id', members[2]))
  await q(admin.from('nba_games').update({ home_score: 40 }).eq('id', game))
  await q(admin.from('leagues').update({ scoring_settings: { points: 4 } }).eq('id', league))
  const afterRemovalResource = await hint('resources')
  await waitFor(() => messages[1].some(row => row.topic === 'resources' && row.revision === afterRemovalResource.revision), 'Current manager misses resource revision after revocation')
  await waitFor(() => messages[1].some(row => row.topic === 'game' && row.revision === 2), 'Current manager misses post-revocation event')
  await new Promise(resolve => setTimeout(resolve, 750))
  assert.equal(messages[2].length, removedCount, 'A removed member receives a later event')
  assert.equal(messages[3].length, 0, 'An outsider receives a private league event')
  assert.equal(messages[4].length, 0, 'Anonymous receives a private league event'); checks += 3
  for (const side of [0, 1]) assert.ok((await q(clients[side].from('league_change_hints').select('*').eq('league_id', league)) ?? []).length > 0)
  for (const side of [2, 3]) assert.deepEqual(await q(clients[side].from('league_change_hints').select('*').eq('league_id', league)), [])
  assert.ok((await anon.from('league_change_hints').select('*').eq('league_id', league)).error)
  for (const client of [...clients, admin]) {
    assert.ok((await client.from('league_change_hints').insert({ league_id: league, topic: 'score', revision: 9 })).error)
    assert.ok((await client.from('league_change_hints').update({ revision: 9 }).eq('league_id', league)).error)
    assert.ok((await client.from('league_change_hints').delete().eq('league_id', league)).error)
  }
  checks += 23
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const functionName of ['emit_league_inventory_change', 'emit_league_resource_change']) {
      assert.equal(await sql(`SELECT has_function_privilege('${role}','private.${functionName}()','EXECUTE')`), 'f')
      checks++
    }
  }
  await q(admin.from('leagues').delete().eq('id', league))
  assert.deepEqual(await q(clients[0].from('league_change_hints').select('*').eq('league_id', league)), []); checks++
  assert.equal(await sql(`SELECT count(*) FROM player_game_stats WHERE game_id='${game}'`), '20')
  checks++
  console.log(JSON.stringify({ passed: checks, roles: ['commissioner', 'manager', 'removed member', 'outsider', 'anonymous', 'service'], bulkRows: 20, scopeOverflow: 17, realRealtime: true, concurrentSessions: 2 }))
} finally {
  for (const { client, channel } of channels) { await client.removeChannel(channel); client.realtime.disconnect() }
  for (const client of clients) client.realtime.disconnect()
  await q(admin.from('leagues').delete().eq('id', league))
  if (projectionRuns.length) await q(admin.from('projection_sync_runs').delete().in('id', projectionRuns))
  if (players.length) await q(admin.from('player_projections').delete().in('player_id', players))
  await q(admin.from('player_game_stats').delete().eq('game_id', game))
  await q(admin.from('nba_games').delete().eq('id', game))
  if (players.length) await q(admin.from('players').delete().in('id', players))
  if (weeks.length) await q(admin.from('season_weeks').delete().in('id', weeks))
  await sql(`DELETE FROM public.league_change_hints WHERE league_id='${league}'`)
  for (const id of users) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error }
  admin.realtime.disconnect()
  console.log(JSON.stringify({ cleanup: 'Exact fixture and Realtime connections removed' }))
}
