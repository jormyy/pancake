import { connect, requestDriver } from './request-driver.ts'
import { Game, id, leagueId, player, randomAt, seed, seedFixture } from './fixture.ts'
import { State, Stored, validate } from './oracle.ts'
import { tableMetrics, type TableStat } from './metrics.ts'

const [side, source, evidence, label = side, limit] = Deno.args
if (!['old', 'new'].includes(side) || !source || !evidence) throw new Error('Usage: old|new SOURCE EVIDENCE [LABEL] [SMOKE_DAYS]')
const url = Deno.env.get('SUPABASE_DB_URL') ?? 'postgresql://postgres:postgres@127.0.0.1:56322/postgres'
const observer = connect(url)
const edge = connect(url, true)
const games: Game[] = JSON.parse(await Deno.readTextFile(`${evidence}/schedule.json`))
await observer.unsafe(await Deno.readTextFile(new URL('./clock.sql', import.meta.url)))
await seedFixture(observer, games)
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:56321')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_benchmark_local')
Deno.env.set('PANCAKE_EDGE_INTERNAL_TOKEN', 'tipoff-benchmark-local')
const realDate = Date
let clock = new realDate(`${games[0].date}T04:00:00Z`).getTime()
const fakeDate = new Proxy(realDate, {
  construct(target, args) { return Reflect.construct(target, args.length ? args : [clock]) },
  get(target, property) { return property === 'now' ? () => clock : Reflect.get(target, property) },
  apply() { return new realDate(clock).toString() },
})
globalThis.Date = fakeDate
let handler: (req: Request) => Promise<Response>
Object.defineProperty(Deno, 'serve', { value: (callback: typeof handler) => { handler = callback; return {} } })
globalThis.fetch = await requestDriver(edge)
const output = console.log.bind(console)
console.log = () => {}
await import(`${new URL(`file://${source}/supabase/functions/lineup-optimizer/index.ts`).href}?bench=${label}`)
await edge.unsafe("SELECT set_config('app.supabase_url','http://127.0.0.1:56321',false),set_config('app.edge_internal_token','tipoff-benchmark-local',false)")
const events = new Map<number, (() => Promise<void>)[]>()
const at = (time: number, action: () => Promise<void>) => { events.set(time, [...events.get(time) ?? [], action]) }
async function observe<T>(action: (sql: typeof observer) => Promise<T>) {
  return await observer.begin(async (transaction) => await action(transaction as unknown as typeof observer))
}
const state: State = { injury: new Map(), projections: new Map(), locked: new Set(), playing: new Set() }
const dates = [...new Set(games.map((g) => g.date))]
for (const [day, date] of dates.entries()) {
  const dayClock = new realDate(`${date}T12:00:00Z`).getTime()
  const dayStart = new realDate(date + 'T00:00:00Z').getTime()
  const offset = new realDate(dayClock).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).includes('GMT-04') ? 4 : 5
  at(dayStart + offset * 3600000, async () => {
    await observe(async (sql) => {
      for (let index = 0; index < 100; index++) {
        const p = player(index)
        const injury = randomAt(day + 1000, index) % 13 === 0 ? 'Out' : null
        state.injury.set(p.id, injury)
        state.projections.set(p.id, 5 + randomAt(day, index) % 4500 / 100)
      }
      await sql`UPDATE public.players p SET injury_status = changes.status FROM jsonb_to_recordset(${sql.json([...state.injury].map(([id, status]) => ({ id, status })))}::jsonb) AS changes(id uuid,status text) WHERE p.id=changes.id`
    })
  })
}
const windows = [...new Set(games.filter((g) => !g.postponed).map((g) => g.time))]
let lateNews = 0
let lockedNews = 0
const postponedGames = new Set<string>()
for (const [index, time] of windows.entries()) {
  const timestamp = new realDate(time).getTime()
  const windowGames = games.filter((g) => g.time === time && !g.postponed)
  const participants = Array.from({ length: 100 }, (_, i) => player(i)).filter((p) => windowGames.some((g) => g.home === p.team || g.away === p.team))
  if (index % 3 === 0 && participants.length) {
    const p = participants[randomAt(index, 3) % participants.length]
    at(timestamp - 3 * 60000, async () => {
      lateNews++
      state.injury.set(p.id, 'Out')
      const date = windowGames[0].date
      const projected = 50 + randomAt(index, 4) % 2000 / 100
      state.projections.set(p.id, projected)
      await observe(async (sql) => {
        await sql`UPDATE public.players SET injury_status='Out' WHERE id=${p.id}`
        await sql`UPDATE public.fantasypros_projection_rows SET points=${projected},fetched_at=now() WHERE player_id=${p.id} AND projection_date=${date}`
      })
    })
  }
  if (index % 7 === 0 && participants.length) {
    const p = participants[randomAt(index, 7) % participants.length]
    at(timestamp + 5 * 60000, async () => {
      lockedNews++
      state.injury.set(p.id, 'Out')
      await observe(async (sql) => { await sql`UPDATE public.players SET injury_status='Out' WHERE id=${p.id}` })
    })
  }
}
for (const game of games.filter((g) => g.postponed)) {
  at(new realDate(game.time).getTime() - 30 * 60000, async () => {
    postponedGames.add(game.sourceId)
    await observe(async (sql) => { await sql`UPDATE public.nba_games SET status='Postponed' WHERE id=${id(10000 + games.indexOf(game))}` })
  })
}
const tipoffChecks = new Set(windows.map((time) => new realDate(time).getTime() - 60000))
const cronSource = await Deno.readTextFile(`${source}/supabase/migrations/${side === 'old' ? '20260814000003_gate_lineup_optimizer_cron.sql' : '20261014000001_pre_tipoff_lineups.sql'}`)
const cronExpression = /'nba-lineup-optimizer',\s*'([^']+)'/.exec(cronSource)?.[1]
if (!cronExpression || !/^(\*|\*\/\d+) \* \* \* \*$/.test(cronExpression)) throw new Error('Unsupported production cron cadence.')
const cadence = cronExpression.startsWith('*/') ? Number(cronExpression.split(' ')[0].slice(2)) : 1
const first = new realDate(`${games[0].date}T04:00:00Z`).getTime()
const fullEnd = new realDate(`${games.at(-1)!.date}T12:00:00Z`).getTime() + 86400000
const end = limit ? Math.min(fullEnd, first + Number(limit) * 86400000) : fullEnd
const ticks = new Set<number>()
for (let time = first; time < end; time += cadence * 60000) ticks.add(time)
const timeline = [...new Set([...ticks, ...events.keys(), ...tipoffChecks])].filter((time) => time >= first && time < end).sort((a, b) => a - b)
const readToday = async (date: string) => await observe(async (sql) => await sql<Stored[]>`SELECT id::text,member_id::text,player_id::text,slot_type::text,game_date::text,set_at::text FROM public.weekly_lineups WHERE league_id=${leagueId} AND game_date=${date} ORDER BY member_id,player_id`)
let invocations = 0
let cronTicks = 0
let checks = 0
let checkedTipoffs = 0
let exactTipoffs = 0
const exactSnapshots: { time: string; rows: Stored[] }[] = []
const actualTipoffTimes = new Set(windows.map((time) => new realDate(time).getTime()))
let day = ''
let previous: Stored[] = []
const snapshots: { time: string; rows: Stored[]; points: number }[] = []
await observer.unsafe('SELECT pg_stat_force_next_flush()')
await edge.unsafe('SELECT pg_stat_force_next_flush()')
await new Promise((resolve) => setTimeout(resolve, 1100))
await observer.unsafe('SELECT pg_stat_reset(), pg_stat_statements_reset()')
const start = performance.now()
for (const time of timeline) {
  clock = time
  await observer`UPDATE bench.clock SET at=${new realDate(clock).toISOString()}`
  const date = new realDate(clock).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  if (day !== date) {
    day = date
    previous = []
    if (side === 'old' || new realDate(time).getUTCDate() % 7 === 0) output(`${label}: ${date}; ${cronTicks} cron ticks, ${invocations} edge calls`)
  }
  for (const event of events.get(time) ?? []) await event()
  state.playing = new Set(games.filter((g) => g.date === date && !postponedGames.has(g.sourceId)).flatMap((g) => [g.home, g.away]))
  state.locked = new Set(Array.from({ length: 100 }, (_, i) => player(i)).filter((p) => games.some((g) => g.date === date && new realDate(g.time).getTime() <= clock && (g.home === p.team || g.away === p.team))).map((p) => p.id))
  if (ticks.has(time)) {
    cronTicks++
    await edge.unsafe(`SELECT public.${side === 'old' ? 'invoke_lineup_optimizer_if_due' : 'invoke_pre_tipoff_optimizer_if_due'}()`)
    const requests = await observer`DELETE FROM bench.requests RETURNING body`
    if (requests.length) {
      const before = await readToday(date)
      for (const request of requests) {
        invocations++
        const response = await handler!(new Request('http://127.0.0.1:56321/functions/v1/lineup-optimizer', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': 'tipoff-benchmark-local' }, body: JSON.stringify(request.body),
        }))
        const body = await response.json()
        if (!response.ok || body.failed > 0) throw new Error(`Edge failed at ${new realDate(clock).toISOString()}: ${JSON.stringify(body)}`)
      }
      const after = await readToday(date)
      checks += validate(after, state, before, side === 'new')
      previous = after
    }
  }
  if (tipoffChecks.has(time)) {
    const rows = await readToday(date)
    checks += validate(rows, state, previous, side === 'new')
    checkedTipoffs++
    const points = rows.reduce((sum, row) => {
      const p = Array.from({ length: 100 }, (_, i) => player(i)).find((p) => p.id === row.player_id)!
      const hasGame = games.some((g) => !g.postponed && g.date === date && (g.home === p.team || g.away === p.team))
      return sum + (hasGame && state.injury.get(p.id) !== 'Out' ? state.projections.get(p.id) ?? 0 : 0)
    }, 0)
    snapshots.push({ time: new realDate(clock).toISOString(), rows, points })
    previous = rows
  }
  if (side === 'new' && actualTipoffTimes.has(time)) {
    checks += validate(previous, state, previous, true)
    exactTipoffs++
    exactSnapshots.push({ time: new realDate(clock).toISOString(), rows: previous })
  }
}
const wallSeconds = (performance.now() - start) / 1000
await edge.unsafe('SELECT pg_stat_force_next_flush()')
await observer.unsafe('SELECT pg_stat_force_next_flush()')
await new Promise((resolve) => setTimeout(resolve, 1100))
await observer.unsafe('SELECT pg_stat_clear_snapshot()')
const statements = await observer`SELECT query,toplevel,calls,rows,total_exec_time FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY calls DESC`
const tableStats = await observer<TableStat[]>`SELECT schemaname,relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables WHERE schemaname IN ('public','private','analytics') ORDER BY relname`
const productionStatements = statements.filter((row) => !row.query.includes('bench.') && !row.query.includes('pg_stat_force_next_flush'))
const totals = await observer`SELECT count(*)::int AS lineups FROM public.weekly_lineups`
const persistedInvocations = await observer`SELECT count(*)::int AS calls FROM public.edge_invocations WHERE function_name='lineup-optimizer'`
if (persistedInvocations[0].calls !== invocations) throw new Error('Invocation count differs from database telemetry.')
const result = {
  side, label, seed, cronExpression, smoke: Boolean(limit), seasonGames: 1230, postponed: 4, teams: 10,
  first: new realDate(first).toISOString(), end: new realDate(end).toISOString(), cronTicks, invocations,
  statements: productionStatements.reduce((sum, row) => sum + Number(row.calls), 0),
  topLevelStatements: productionStatements.filter((row) => row.toplevel).reduce((sum, row) => sum + Number(row.calls), 0),
  statementRows: productionStatements.reduce((sum, row) => sum + Number(row.rows), 0),
  ...tableMetrics(tableStats),
  wallSeconds, checks, checkedTipoffs, exactTipoffs, lateNews, lockedNews, storedLineups: totals[0].lineups,
}
const lineups = await observer`SELECT member_id::text,player_id::text,slot_type::text,game_date::text FROM public.weekly_lineups ORDER BY game_date,member_id,slot_type`
let dispatchProof = null
if (side === 'new') {
  const expected = windows.filter((time) => new realDate(time).getTime() >= first && new realDate(time).getTime() < end)
  const dispatches = await observer`SELECT tipoff_at,status,attempts FROM public.lineup_tipoff_dispatches ORDER BY tipoff_at`
  const receipts = await observer`SELECT tipoff_at,input_revision,count(*)::int AS teams FROM public.lineup_tipoff_members GROUP BY tipoff_at,input_revision ORDER BY tipoff_at,input_revision`
  const [enabled] = await observer`SELECT count(*)::int AS teams FROM public.lineup_optimizer_settings WHERE enabled`
  const attempts = dispatches.reduce((sum, d) => sum + Number(d.attempts), 0)
  if (dispatches.length !== expected.length || invocations !== attempts || checkedTipoffs !== expected.length || exactTipoffs !== expected.length
    || dispatches.some((d, i) => new realDate(d.tipoff_at).toISOString() !== expected[i] || d.status !== 'succeeded')
    || receipts.length !== attempts || receipts.some((r) => r.teams !== enabled.teams)) {
    throw new Error('Not every opted-in team completes exactly once at every distinct tipoff.')
  }
  dispatchProof = { windows: expected.length, inputVersions: attempts, exactTipoffs, teamsPerWindow: enabled.teams, receipts: receipts.reduce((sum, r) => sum + r.teams, 0) }
}
const [statisticsInfo] = await observer`SELECT * FROM pg_stat_statements_info`
if (Number(statisticsInfo.dealloc) !== 0) throw new Error('Statement statistics were evicted.')
for (const [name, data] of Object.entries({ result, statements, 'table-stats': tableStats, snapshots, lineups, 'dispatch-proof': dispatchProof, 'exact-snapshots': exactSnapshots, 'statistics-info': statisticsInfo })) {
  await Deno.writeTextFile(`${evidence}/${label}-${name}.json`, JSON.stringify(data, null, 2))
}
output(JSON.stringify(result, null, 2))
await edge.end()
await observer.end()
