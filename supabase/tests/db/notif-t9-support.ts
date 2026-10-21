import { strict as assert } from 'node:assert'
import path from 'node:path'

const db = Deno.env.get('SUPABASE_DB_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
const api = Deno.env.get('SUPABASE_URL')!
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && Number(new URL(api).port) === Number(port) - 1)
export const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const adminDb = new URL(db)
adminDb.username = 'supabase_admin'
export async function sql(source: string, admin = false) {
  const result = await new Deno.Command('psql', { args: [admin ? adminDb.href : db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', `DO $$ BEGIN PERFORM set_config('app.supabase_url','http://127.0.0.1:1',false); PERFORM set_config('app.edge_internal_token','synthetic-notif-source-test',false); END $$; ${source}`], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
async function sqlFile(file: string, args: string[] = []) {
  const result = await new Deno.Command('psql', { args: [adminDb.href, '-XqAtv', 'ON_ERROR_STOP=1', ...args, '-f', file], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
}
export type OutboxRow = { id: string; member_id: string; event_type: string; category: string; dedupe_key: string; data: Record<string, unknown>; suppressed_at: string | null; suppression_reason: string | null; delivered_at: string | null }
export const rows = async (event: string, scope: string) => JSON.parse(await sql(`SELECT COALESCE(json_agg(row_to_json(o) ORDER BY o.id),'[]') FROM notification_outbox o WHERE event_type=${q(event)} AND (${scope})`)) as OutboxRow[]
export async function expectRows(event: string, scope: string, members: string[], retry: () => Promise<unknown>) {
  const before = await rows(event, scope)
  assert.deepEqual(before.map(row => row.member_id).sort(), [...members].sort(), `${event}: exact source recipients`)
  assert.equal(new Set(before.map(row => row.dedupe_key)).size, before.length, `${event}: unique occurrence/member keys`)
  assert.ok(before.every(row => row.dedupe_key.startsWith((event === 'trade_completion_failed' ? 'trade_terminal_failure' : event === 'matchup_final' ? 'matchup' : event) + ':')))
  await retry()
  assert.deepEqual((await rows(event, scope)).map(row => row.id), before.map(row => row.id), `${event}: source retry cannot add a second row`)
  return before
}
export class Fixture {
  users: string[] = Array.from({ length: 5 }, () => crypto.randomUUID())
  leagues: string[] = []
  players: string[] = []
  games: string[] = []
  years: number[] = []
  memberUsers = new Map<string, string>()
  foreignMembers: string[] = []
  foreignLeague = ''
  async init() {
    await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) SELECT id,id||'@example.test',jsonb_build_object('username',id::text) FROM unnest(ARRAY[${this.users.map(q)}]::uuid[]) id;
      INSERT INTO notification_preferences(user_id,event_settings) SELECT id,(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog) FROM unnest(ARRAY[${this.users.map(q)}]::uuid[]) id;
      UPDATE profiles SET push_token='fake-notif-t9-'||id WHERE id IN (${this.users.map(q)});`)
    const foreign = await this.league('offseason', 0, false)
    this.foreignMembers.push(...foreign.members)
    this.foreignLeague = foreign.id
    const outsider = crypto.randomUUID()
    this.foreignMembers.push(outsider)
    this.memberUsers.set(outsider, this.users[4])
    await sql(`INSERT INTO league_members(id,league_id,user_id,role) VALUES(${q(outsider)},${q(foreign.id)},${q(this.users[4])},'manager')`)
    return this
  }
  async year() {
    const year = Number(await sql('SELECT y FROM generate_series(22000,29999) y WHERE NOT EXISTS(SELECT 1 FROM season_weeks WHERE season_year=y) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=y) LIMIT 1'))
    assert.ok(year)
    this.years.push(year)
    await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year},w,date '2026-10-19'+(w-1)*7,date '2026-10-25'+(w-1)*7 FROM generate_series(1,24) w`)
    return year
  }
  async league(status = 'active', rotation = 0, calendar = true, playoffStart = 20) {
    const id: string = crypto.randomUUID(), season: string = crypto.randomUUID()
    const year = calendar ? await this.year() : 21999
    const members = Array.from({ length: 4 }, (_, index) => String(index + 1).padStart(8, '0') + crypto.randomUUID().slice(8))
    this.leagues.push(id)
    for (let index = 0; index < 4; index++) this.memberUsers.set(members[index], this.users[(index + rotation) % 4])
    await sql(`INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,weekly_add_limit,playoff_entrants,playoff_round_lengths,trade_veto_mode,waiver_mode,trade_deadline,playoff_start_week)
        VALUES(${q(id)},'Synthetic notification proof',${q(id)},${q(this.memberUsers.get(members[0])!)},${q(status)}::league_status,30,NULL,2,ARRAY[1],'disabled','faab','21999-02-15',${playoffStart});
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(id)},${year},true);
      ${members.map((member, index) => `INSERT INTO league_members(id,league_id,user_id,role) VALUES(${q(member)},${q(id)},${q(this.memberUsers.get(member)!)},'${index ? 'manager' : 'commissioner'}');`).join('\n')}
      INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) SELECT ${q(id)},${q(season)},member,ord FROM unnest(ARRAY[${members.map(q)}]::uuid[]) WITH ORDINALITY u(member,ord);`)
    return { id, season, year, members }
  }
  async player() {
    const id = crypto.randomUUID()
    this.players.push(id)
    await sql(`INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team,years_exp,nba_draft_number,espn_id)
      VALUES(${q(id)},'Synthetic',${q(id)},'PG',ARRAY['PG'],'Active','BOS',0,1,${q('notif-' + id)})`)
    return id
  }
  async game(year: number, day: string, week: number, prefix = '002', statusText: string | null = null) {
    const id = crypto.randomUUID()
    this.games.push(id)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,game_status_text)
      VALUES(${q(id)},${q(prefix + String(1000000 + Math.floor(Math.random() * 9000000)))},${year},${week},${q(day)},${q(day + 'T23:00:00Z')},'BOS','NYK','Scheduled',${statusText === null ? 'NULL' : q(statusText)})`)
    return id
  }
  async negative(events: string[]) {
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type IN (${events.map(q)}) AND member_id IN (${this.foreignMembers.map(q)})`), '0', 'Same users in another league cannot receive this league event')
    assert.equal(await sql(`SELECT count(*) FROM notification_outbox o JOIN league_members m ON m.id=o.member_id WHERE m.user_id=${q(this.users[4])}`), '0', 'Non-member cannot receive an event')
  }
  async cleanup() {
    if (this.leagues.length) await sql(`UPDATE draft_picks SET rookie_draft_id=NULL WHERE league_id IN (${this.leagues.map(q)});
      DELETE FROM snake_draft_picks WHERE draft_id IN (SELECT id FROM drafts WHERE league_id IN (${this.leagues.map(q)}));
      DELETE FROM draft_orders WHERE draft_id IN (SELECT id FROM drafts WHERE league_id IN (${this.leagues.map(q)}));
      DELETE FROM draft_picks WHERE league_id IN (${this.leagues.map(q)});
      DELETE FROM drafts WHERE league_id IN (${this.leagues.map(q)});
      DELETE FROM leagues WHERE id IN (${this.leagues.map(q)});`)
    await sql(`DELETE FROM auth.users WHERE id IN (${this.users.map(q)}); DELETE FROM profiles WHERE id IN (${this.users.map(q)});`)
    if (this.players.length) await sql(`DELETE FROM players WHERE id IN (${this.players.map(q)})`)
    if (this.games.length) await sql(`DELETE FROM nba_games WHERE id IN (${this.games.map(q)})`)
    if (this.years.length) await sql(`DELETE FROM season_weeks WHERE season_year IN (${this.years})`)
  }
}
export type League = Awaited<ReturnType<Fixture['league']>>
export class Clock {
  active = false
  jobs: { jobname: string; schedule: string; command: string; active: boolean }[] = []
  minute = ''
  async start(at: string) {
    this.jobs = JSON.parse(await sql("SELECT json_agg(row_to_json(j)) FROM (SELECT jobname,schedule,command,active FROM cron.job) j"))
    const command = this.jobs.find(job => job.jobname === 'notification-dispatch-minute')?.command
    assert.ok(command)
    this.minute = command
    const ms = String(Date.parse(at))
    await sqlFile('scripts/season-sim/clock.sql', ['-v', `season_sim_port=${port}`, '-v', `sim_ms=${ms}`, '-v', `real_ms=${Date.now()}`, '-v', 'rate=0', '-v', `cap_ms=${ms}`])
    this.active = true
  }
  async at(at: string) {
    assert.ok(this.active)
    await sql(`UPDATE season_sim.clock SET sim_ms=extract(epoch FROM ${q(at)}::timestamptz)*1000,cap_ms=extract(epoch FROM ${q(at)}::timestamptz)*1000,rate=0`, true)
  }
  async scan(at: string) { await this.at(at); await sql(this.minute) }
  async restore() {
    if (!this.active) return
    await sqlFile('scripts/season-sim/restore-clock.sql', ['-v', `season_sim_port=${port}`])
    for (const job of this.jobs) await sql(`SELECT cron.schedule(${q(job.jobname)},${q(job.schedule)},${q(job.command)}); SELECT cron.alter_job(jobid,active:=${job.active}) FROM cron.job WHERE jobname=${q(job.jobname)};`)
    this.active = false
  }
}
export class Transport {
  pushes: { data: { outboxId: string; notificationEvent: string } }[] = []
  fake: Deno.HttpServer<Deno.NetAddr> | undefined
  worker: Deno.HttpServer<Deno.NetAddr> | undefined
  aux: Deno.HttpServer<Deno.NetAddr>[] = []
  extra: Deno.HttpServer<Deno.NetAddr>[] = []
  origins: string[] = []
  nativeFetch = globalThis.fetch.bind(globalThis)
  async start() {
    const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
    assert.ok(token)
    this.fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
      const body = await request.json()
      if (new URL(request.url).pathname === '/receipts') return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
      this.pushes.push(...body)
      return Response.json({ data: body.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
    })
    Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${this.fake.addr.port}/send`)
    Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${this.fake.addr.port}/receipts`)
    Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
    const serve = Deno.serve, descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
    Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
      this.worker = serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
      return this.worker
    } })
    try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
    assert.ok(this.worker)
    globalThis.fetch = (input, init) => {
      const origin = new URL(input instanceof Request ? input.url : input).origin
      assert.ok([new URL(api).origin, `http://127.0.0.1:${this.fake!.addr.port}`, `http://127.0.0.1:${this.worker!.addr.port}`, ...[...this.aux, ...this.extra].map(server => `http://127.0.0.1:${server.addr.port}`), ...this.origins].includes(origin), 'Only own local services receive requests')
      return this.nativeFetch(input, init)
    }
  }
  async waivers() {
    if (!this.aux.length) {
      const serve = Deno.serve, descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
      Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
        const server = serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
        this.aux.push(server)
        return server
      } })
      try { await import('../../functions/process-waivers/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
    }
    const response = await fetch(`http://127.0.0.1:${this.aux[0].addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: '{}' })
    assert.equal(response.status, 200, await response.text())
  }
  async serve(load: () => Promise<unknown>) {
    let server: Deno.HttpServer<Deno.NetAddr> | undefined
    const serve = Deno.serve, descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
    Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
      server = serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
      return server
    } })
    try { await load() } finally { Object.defineProperty(Deno, 'serve', descriptor) }
    assert.ok(server, 'The worker module must start exactly one local server')
    this.extra.push(server)
    return server
  }
  async invoke(server: Deno.HttpServer<Deno.NetAddr>) {
    const response = await fetch(`http://127.0.0.1:${server.addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: '{}' })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  async drain() {
    assert.ok(this.worker)
    const response = await fetch(`http://127.0.0.1:${this.worker.addr.port}`, { method: 'POST', headers: { 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: '{}' })
    assert.equal(response.status, 200, await response.text())
  }
  async prove(f: Fixture, batch: OutboxRow[], sourceTest: string, proofPath?: string) {
    assert.ok(batch.length)
    assert.ok(batch.every(row => row.suppressed_at === null && row.delivered_at === null), 'Real source rows must be pending before any preference changes')
    const events = [...new Set(batch.map(row => row.event_type))]
    await f.negative(events)
    const categories = JSON.parse(await sql(`SELECT json_agg(DISTINCT category) FROM notif_event_catalog WHERE event_type IN (${events.map(q)})`)) as string[]
    const enabled = JSON.stringify(Object.fromEntries(events.map(event => [event, true])))
    await sql(`UPDATE notification_preferences SET master_enabled=true,category_settings='{}',event_settings=(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog)||${q(enabled)}::jsonb WHERE user_id IN (${f.users.slice(0, 4).map(q)});
      UPDATE notification_preferences SET event_settings=event_settings||${q(JSON.stringify(Object.fromEntries(events.map(event => [event, false]))))}::jsonb WHERE user_id=${q(f.users[0])};
      UPDATE notification_preferences SET category_settings=${q(JSON.stringify(Object.fromEntries(categories.map(category => [category, false]))))}::jsonb WHERE user_id=${q(f.users[1])};
      UPDATE notification_preferences SET master_enabled=false WHERE user_id=${q(f.users[2])};`)
    assert.equal(this.pushes.filter(push => batch.some(row => row.id === push.data.outboxId)).length, 0, 'All switches change after source rows exist, before any attempt')
    let states: OutboxRow[] = []
    for (let pass = 0; pass < 40; pass++) {
      await this.drain()
      states = JSON.parse(await sql(`SELECT json_agg(row_to_json(o)) FROM notification_outbox o WHERE id IN (${batch.map(row => q(row.id))})`))
      if (states.every(row => row.suppressed_at || row.delivered_at)) break
    }
    for (const row of states) {
      const user = f.memberUsers.get(row.member_id)
      const attempts = this.pushes.filter(push => push.data.outboxId === row.id)
      if (user === f.users[3]) {
        assert.ok(row.delivered_at, `${row.event_type}: control needs a fake receipt`)
        assert.equal(row.suppressed_at, null)
        assert.equal(attempts.length, 1, `${row.event_type}: one transport attempt per control occurrence`)
      } else {
        assert.ok(row.suppressed_at, JSON.stringify(row))
        assert.equal(row.suppression_reason, 'preferences_disabled', `${row.event_type}: send-time suppression`)
        assert.equal(row.delivered_at, null)
        assert.equal(attempts.length, 0)
      }
    }
    for (const event of events) {
      const eventRows = batch.filter(row => row.event_type === event)
      assert.deepEqual([...new Set(eventRows.map(row => f.users.indexOf(f.memberUsers.get(row.member_id)!)))].sort(), [0, 1, 2, 3], `${event}: all three independent switches and control must be represented`)
      const observation = { event, test: sourceTest, ...(proofPath ? { path: proofPath } : {}), source: 'SPECIFIC', recipients: 'SPECIFIC', dedupe: 'SPECIFIC', optOut: { event: 'SPECIFIC', category: 'SPECIFIC', master: 'SPECIFIC' }, sendTime: true, receipt: 'SPECIFIC', rows: eventRows.map(row => row.id) }
      console.log(JSON.stringify(observation))
      const folder = Deno.env.get('NOTIF_EVIDENCE')
      if (folder) {
        assert.ok(path.isAbsolute(folder) && !folder.startsWith(Deno.cwd() + '/'))
        await Deno.writeTextFile(path.join(folder, 'proof-observations.jsonl'), JSON.stringify(observation) + '\n', { append: true })
      }
    }
    const count = this.pushes.length
    await this.drain()
    assert.equal(this.pushes.length, count, 'A repeated drain cannot resend receipted or suppressed rows')
  }
  async close() {
    globalThis.fetch = this.nativeFetch
    for (const server of [...this.aux, ...this.extra]) await server.shutdown()
    await this.fake?.shutdown()
    await this.worker?.shutdown()
  }
}
