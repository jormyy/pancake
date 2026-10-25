import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { withTaxiCapture } from '../../scripts/ios-sim/seed.mjs'
import { expandScenarios } from '../../scripts/ios-sim/run.mjs'

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const leagueId = id(1), seasonId = id(2), memberId = id(3)
const players = Array.from({ length: 260 }, (_, index) => ({ id: id(100 + index) }))
const fixture = { leagueId, seasonId, members: [{ id: memberId }], players }
const scope = { league_id: leagueId, league_season_id: seasonId, member_id: memberId }
const modes = ['tags', 'open', 'full', 'claim', 'illegal-taxi', 'illegal-ir', 'trade-taxi', 'trade-ir']

function database(existingLog = false) {
  const tables: Record<string, any[]> = {
    leagues: [{ id: leagueId, roster_size: 20, taxi_slots: 3, weekly_add_limit: 5, trade_deadline: '2020-01-01' }],
    drafts: [{ id: id(504), league_id: leagueId, league_season_id: seasonId, draft_type: 'auction', is_mock: false }],
    players: [0, 20, 21, 220, 230, 240].map(index => ({ id: players[index].id, years_exp: 7, career_regular_season_games: 99, injury_status: index === 20 ? 'Out' : 'Doubtful' })),
    roster_players: [0, 20, 21].map(index => ({ ...scope, id: id(400 + index), player_id: players[index].id, is_on_taxi: index === 21, is_on_ir: index === 20 })),
    roster_transactions: [{ ...scope, id: id(500), player_id: players[220].id }],
    weekly_add_counts: [{ ...scope, week_number: 1, add_count: 2 }],
    waiver_claims: [],
    league_activity: [{ id: id(501), league_id: leagueId, league_season_id: seasonId, actor_member_id: memberId }],
    trades: [{ id: id(502), league_id: leagueId, league_season_id: seasonId, proposer_member_id: memberId }],
    league_member_taxi_exits: [],
    taxi_acquisition_context: [{ transaction_id: '100', source: 'free_agent' }],
    waiver_wire_log: existingLog ? [{ id: id(503), league_id: leagueId, league_season_id: seasonId, player_id: players[230].id, cleared_at: null, clears_at: '2020-01-01T00:00:00Z' }] : [],
  }
  let failUpdate = 0, updates = 0
  const admin = {
    from(table: string) {
      const filters: ((row: any) => boolean)[] = []
      let columns = '*', update: object | undefined, insert: any[] | undefined, removing = false
      const result = () => {
        const rows = tables[table].filter(row => filters.every(filter => filter(row)))
        if (update && ++updates === failUpdate) return { data: null, error: { message: 'Setup write failed' } }
        if (update) for (const row of rows) Object.assign(row, update)
        if (removing) tables[table] = tables[table].filter(row => !rows.includes(row))
        const data = insert ? insert.map(row => ({ ...(table === 'weekly_add_counts' ? {} : { id: id(600) }), ...row })) : rows
        if (insert) tables[table].push(...data)
        return { data: structuredClone(data.map(row => columns === '*' ? row : Object.fromEntries(columns.split(',').map(key => [key, row[key]])))), error: null }
      }
      const query = {
        select(value = '*') { columns = value; return query },
        eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query },
        is(key: string, value: unknown) { return query.eq(key, value) },
        in(key: string, value: unknown[]) { filters.push(row => value.includes(row[key])); return query },
        update(value: object) { update = value; return query },
        insert(value: any) { insert = Array.isArray(value) ? value : [value]; return query },
        delete() { removing = true; return query },
        async single() { const value = result(); return { ...value, data: value.data?.[0] } },
        then(resolve: (value: object) => void) { resolve(result()) },
      }
      return query
    },
  }
  const statements: string[] = []
  const execute = async (command: string, args: string[] = []) => {
    assert.equal(command, 'docker')
    assert.equal(args[1], 'supabase_db_pancake_ios_shared')
    const sql = args.at(-1)!
    statements.push(sql)
    if (sql.includes('DELETE FROM roster_players')) {
      assert.ok(sql.includes("'draft_reset'"))
      assert.ok(sql.includes(`member_id='${memberId}'`))
      assert.ok(sql.includes(`league_season_id='${seasonId}'`))
      assert.ok(sql.includes('DELETE FROM private.taxi_acquisition_context'))
      assert.ok(sql.includes('SELECT xmin::text FROM roster_players'))
      assert.ok(sql.includes("AND source='free_agent'"))
      tables.taxi_acquisition_context = tables.taxi_acquisition_context.filter(row => row.transaction_id !== '200')
      const rowId = /DELETE FROM roster_players WHERE id='([^']+)'/.exec(sql)![1]
      tables.roster_players = tables.roster_players.filter(row => row.id !== rowId)
    } else {
      const rowId = /DELETE FROM league_activity WHERE id='([^']+)'/.exec(sql)![1]
      tables.league_activity = tables.league_activity.filter(row => row.id !== rowId)
    }
    return ''
  }
  return { admin, tables, execute, statements, failAt: (value: number) => { failUpdate = value } }
}

function acquisition(tables: Record<string, any[]>) {
  tables.roster_players.push({ ...scope, id: id(700), player_id: players[220].id, is_on_taxi: true, is_on_ir: false })
  tables.roster_transactions.push({ ...scope, id: id(701), player_id: players[220].id })
  tables.league_activity.push({ id: id(702), league_id: leagueId, league_season_id: seasonId, actor_member_id: memberId })
  tables.weekly_add_counts[0].add_count++
  tables.taxi_acquisition_context.push({ transaction_id: '200', source: 'free_agent' })
}

for (const mode of modes) {
  test.each([false, true])(`taxi ${mode} restores every owned row after success or capture failure: %s`, async fail => {
    const db = database()
    const before = structuredClone(db.tables)
    const capture = () => withTaxiCapture(db.admin, { fixture, memberId, mode, execute: db.execute }, async () => {
      const player = (index: number) => db.tables.players.find(row => row.id === players[index].id)!
      assert.deepEqual([player(220).years_exp, player(220).career_regular_season_games], [0, 0])
      assert.deepEqual([player(230).years_exp, player(230).career_regular_season_games], [2, 64])
      assert.deepEqual([player(240).years_exp, player(240).career_regular_season_games], [4, 65])
      assert.equal(player(220).injury_status, null)
      assert.equal(player(20).injury_status, ['illegal-ir', 'trade-ir'].includes(mode) ? null : 'Out')
      assert.equal(player(21).career_regular_season_games, ['illegal-taxi', 'trade-taxi'].includes(mode) ? 65 : 0)
      assert.equal(db.tables.leagues[0].roster_size, mode === 'open' ? 2 : 1)
      assert.equal(db.tables.leagues[0].taxi_slots, 2)
      assert.equal(db.tables.leagues[0].weekly_add_limit, null)
      assert.equal(db.tables.drafts[0].is_mock, mode.startsWith('trade-'))
      assert.equal(db.tables.leagues[0].trade_deadline, mode.startsWith('trade-') ? null : '2020-01-01')
      if (mode === 'claim') assert.ok(Date.parse(db.tables.waiver_wire_log[0].clears_at) > Date.now())
      if (mode === 'open') acquisition(db.tables)
      if (fail) throw new Error('Capture failed')
      return 'captured'
    })
    if (fail) await assert.rejects(capture(), /Capture failed/)
    else assert.equal(await capture(), 'captured')
    assert.deepEqual(db.tables, before)
    if (mode === 'open') assert.equal(db.statements.length, 2)
  })
}

test('taxi capture restores a partly prepared fixture after a setup write fails', async () => {
  const db = database()
  const before = structuredClone(db.tables)
  db.failAt(4)
  await assert.rejects(withTaxiCapture(db.admin, { fixture, memberId, mode: 'claim', execute: db.execute }, async () => assert.fail('Capture must not start')), /Setup write failed/)
  assert.deepEqual(db.tables, before)
})

test.each([false, true])('taxi claim restores an existing waiver deadline after success or failure: %s', async fail => {
  const db = database(true)
  const before = structuredClone(db.tables)
  const capture = () => withTaxiCapture(db.admin, { fixture, memberId, mode: 'claim', execute: db.execute }, async () => {
    assert.equal(db.tables.waiver_wire_log.length, 1)
    assert.ok(Date.parse(db.tables.waiver_wire_log[0].clears_at) > Date.now())
    if (fail) throw new Error('Capture failed')
  })
  if (fail) await assert.rejects(capture(), /Capture failed/)
  else await capture()
  assert.deepEqual(db.tables, before)
})

test.each(['roster', 'trade'])('an illegal action that writes a %s fails the capture and removes its records', async kind => {
  const db = database()
  const before = structuredClone(db.tables)
  await assert.rejects(withTaxiCapture(db.admin, { fixture, memberId, mode: 'illegal-taxi', execute: db.execute }, async () => {
    if (kind === 'roster') acquisition(db.tables)
    else db.tables.trades.push({ id: id(703), league_id: leagueId, league_season_id: seasonId, proposer_member_id: memberId })
  }), /changed roster_players|created an offer/)
  assert.deepEqual(db.tables, before)
})

test('the successful taxi capture rejects an active acquisition and still restores it', async () => {
  const db = database()
  const before = structuredClone(db.tables)
  await assert.rejects(withTaxiCapture(db.admin, { fixture, memberId, mode: 'open', execute: db.execute }, async () => {
    acquisition(db.tables)
    db.tables.roster_players.at(-1)!.is_on_taxi = false
  }), /must use a taxi slot/)
  assert.deepEqual(db.tables, before)
})

test('taxi scenarios parse through the runner and cover every surface in both themes', async () => {
  const scenarios = expandScenarios(JSON.parse(await readFile('scripts/ios-sim/scenarios/taxi.json', 'utf8')))
  const surfaces = ['player-tags', 'player-detail', 'add-open', 'add-full', 'waiver', 'illegal-taxi', 'illegal-ir', 'illegal-taxi-trade', 'illegal-ir-trade']
  assert.equal(scenarios.length, surfaces.length * 2)
  for (const theme of ['light', 'dark']) for (const surface of surfaces) {
    const scenario = scenarios.find((row: any) => row.name === `taxi-${surface}-${theme}`)!
    assert.ok(scenario)
    assert.equal(scenario.group, 'taxi')
    assert.deepEqual(scenario.prepare[0], { tap: theme === 'light' ? 'Light' : 'Dark' })
    assert.equal(scenario.setup.taxiMember, '{{memberId}}')
    assert.ok(modes.includes(scenario.setup.taxiMode))
    for (const step of scenario.steps) assert.ok(step.expected.text || step.expected.selector || step.expected.dialog)
  }
  assert.ok(scenarios.some((row: any) => JSON.stringify(row).includes('Confirm and send trade')))
  const list = scenarios.find((row: any) => row.name === 'taxi-player-tags-light')!
  assert.equal(list.steps.length, 3)
  assert.ok(list.steps[2].expected.selector.endsWith(':empty'))
})
