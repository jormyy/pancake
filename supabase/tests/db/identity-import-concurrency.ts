import assert from 'node:assert/strict'

const db = Deno.env.get('SUPABASE_DB_URL')!
const target = new URL(db)
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
assert.equal(target.port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const uuid = () => crypto.randomUUID()
const mode = Deno.args[0] ?? 'optimizer'
assert.ok(['optimizer', 'stats'].includes(mode))

class SqlSession {
  child = new Deno.Command('psql', {
    args: [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
    env: { PGOPTIONS: '-c statement_timeout=15000 -c lock_timeout=12000 -c idle_in_transaction_session_timeout=30000 -c enable_indexscan=off -c enable_bitmapscan=off' },
    stdin: 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn()
  writer = this.child.stdin.getWriter()
  reader = this.child.stdout.getReader()
  errors = new Response(this.child.stderr).text()
  buffer = ''
  closed = false
  async sql(statement: string): Promise<string> {
    const marker = uuid()
    let timer: number | undefined
    const work = async () => {
      await this.writer.write(new TextEncoder().encode(`${statement};\n\\echo ${marker}\n`))
      while (!this.buffer.includes(marker)) {
        const next = await this.reader.read()
        if (next.done) throw new Error(await this.errors)
        this.buffer += new TextDecoder().decode(next.value)
      }
      const result = this.buffer.slice(0, this.buffer.indexOf(marker)).trim()
      this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
      return result
    }
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { try { this.child.kill('SIGTERM') } catch {} reject(new Error('Own SQL statement exceeds 20 seconds')) }, 20000)
      })])
    } finally { clearTimeout(timer) }
  }
  async close() {
    if (this.closed) return
    this.closed = true
    try { await this.writer.close() } catch {}
    try { await this.reader.cancel() } catch {}
    await this.child.status
    await this.errors
  }
}

const sessions: SqlSession[] = []
const session = () => { const value = new SqlSession(); sessions.push(value); return value }
const owner = uuid(), league = uuid(), season = uuid(), member = uuid(), game = uuid(), token = uuid()
const players = [uuid(), uuid()].sort()
const [low, high] = players
const provider = (id: string) => `identity-concurrency-${id}`
const controller = session(), importer = session(), optimizer = session(), observer = session()
let importWork: Promise<string> | undefined, optimizerWork: Promise<string> | undefined
let tip = '', day = ''
try {
  const controllerPid = Number(await controller.sql('SELECT pg_backend_pid()'))
  const importerPid = Number(await importer.sql('SELECT pg_backend_pid()'))
  const optimizerPid = Number(await optimizer.sql('SELECT pg_backend_pid()'))
  day = await observer.sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
  tip = await observer.sql("SELECT now()+interval '10 minutes'")
  await observer.sql(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(${q(owner)},'authenticated','authenticated',${q(owner + '@example.test')},'x',now(),'{}','{}',now(),now());
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size)
      VALUES(${q(league)},'Synthetic identity lock order',${q(league)},${q(owner)},'active',2);
    INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(owner)},'commissioner','Team');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},2197,true);
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2197,1,${q(day)}::date-3,${q(day)}::date+3);
    INSERT INTO players(id,first_name,last_name,nba_team,position,eligible_positions)
      VALUES ${[high, low].map(id => `(${q(id)},'Synthetic',${q(id)},'BOS','PG',ARRAY['PG'])`).join(',')};
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES ${players.map(id => `(${q(league)},${q(season)},${q(member)},${q(id)},'draft',now()-interval '1 day')`).join(',')};
    INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
      VALUES ${players.map(id => `(${q(league)},${q(season)},${q(member)},${q(id)},${q(day)},1,'UTIL')`).join(',')};
    INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      VALUES(${q(game)},${q(provider(game))},2197,1,${q(day)},'BOS','MIA','Scheduled',${q(tip)});
    INSERT INTO lineup_tipoff_dispatches(tipoff_at,game_date,status,token,lease_until)
      VALUES(${q(tip)},${q(day)},'running',${q(token)},now()+interval '1 hour');
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
      VALUES(${q(league)},${q(season)},${q(member)},true)
      ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
    COMMIT`)
  const blocked = async (waiter: number, ...blockers: number[]) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await observer.sql(`SELECT ${blockers.map(blocker => `${blocker}=ANY(pg_blocking_pids(${waiter}))`).join(' OR ')}`) === 't') return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`Own session ${waiter} does not block on ${blockers}`)
  }
  await controller.sql(`BEGIN; SELECT id FROM players WHERE id=${q(high)} FOR UPDATE`)
  const records = [high, low].map(id => ({ provider_id: provider(id), display_name: `Synthetic ${id}`,
    ...(mode === 'stats' ? { nba_game_id: provider(game) } : {}),
  }))
  importWork = importer.sql(`BEGIN; SELECT resolve_player_imports_atomic('nba_cdn',${q(JSON.stringify(records))}::jsonb); COMMIT`)
  const importOutcome = importWork.then(value => ({ value, error: '' }), error => ({ value: '', error: String(error) }))
  await blocked(importerPid, controllerPid)
  const assignments = players.map(player_id => ({ player_id, slot_type: 'UTIL' }))
  const statRows = players.map(player_id => ({ player_id, game_id: game, points: 1, did_not_play: false }))
  optimizerWork = optimizer.sql(mode === 'stats'
    ? `BEGIN; SELECT save_game_stats_atomic(${q(game)},${q(provider(game))},${q(JSON.stringify(statRows))}::jsonb,false); COMMIT`
    : `BEGIN; SELECT apply_pre_tipoff_lineup(${q(tip)},${q(token)},${q(league)},${q(season)},${q(member)},${q(JSON.stringify(assignments))}::jsonb); COMMIT`)
  const optimizerOutcome = optimizerWork.then(value => ({ value, error: '' }), error => ({ value: '', error: String(error) }))
  await blocked(optimizerPid, importerPid, controllerPid)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', mode, gated: { importerPid, optimizerPid, controllerPid }, players: { low, high }, providerOrder: [high, low], optimizerOrder: [low, high] }))
  await controller.sql('COMMIT')
  const results = await Promise.all([importOutcome, optimizerOutcome])
  console.log(JSON.stringify({ results }))
  assert.ok(results.every(result => !result.error), `Concurrent real functions must complete without SQLSTATE 40P01: ${JSON.stringify(results)}`)
  const receipt = JSON.parse(results[0].value)
  assert.deepEqual(receipt.results.map((row: { player_id: string }) => row.player_id), [high, low])
  assert.equal(results[1].value, mode === 'stats' ? '2' : 'f')
  assert.equal(await observer.sql(`SELECT count(*) FROM players WHERE id IN (${players.map(q).join(',')}) AND nba_id='identity-concurrency-'||id::text`), '2')
  assert.equal(await observer.sql(`SELECT count(*) FROM weekly_lineups WHERE league_id=${q(league)}`), '2')
} finally {
  try { await controller.sql('ROLLBACK') } catch {}
  await Promise.allSettled([importWork, optimizerWork])
  for (const value of sessions) await value.close()
  const cleanup = new SqlSession()
  try {
    await cleanup.sql(`DELETE FROM lineup_tipoff_members WHERE tipoff_at=${q(tip || '1900-01-01')};
      DELETE FROM lineup_tipoff_dispatches WHERE tipoff_at=${q(tip || '1900-01-01')};
      DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id=${q(game)};
      DELETE FROM nba_games WHERE id=${q(game)};
      DELETE FROM players WHERE id IN (${players.map(q).join(',')});
      DELETE FROM season_weeks WHERE season_year=2197 AND week_start=${q(day || '1900-01-01')}::date-3;
      DELETE FROM auth.users WHERE id=${q(owner)};`)
  } finally { await cleanup.close() }
}
console.log(`PASS: ${mode} and resolver locks complete; receipt order and ownership survive`)
