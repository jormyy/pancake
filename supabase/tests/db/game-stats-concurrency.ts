import { strict as assert } from 'node:assert'
const api = Deno.env.get('SUPABASE_URL'), db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(api && db)
assert.ok(['localhost','127.0.0.1'].includes(new URL(api).hostname))
assert.ok(['localhost','127.0.0.1'].includes(new URL(db).hostname))
const uuid = () => crypto.randomUUID()
class SqlSession {
  process = new Deno.Command('psql', {
    args: [db!, '-X', '-qAt', '--set', 'ON_ERROR_STOP=1'],
    env: { PGOPTIONS: '-c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=120000' },
    stdin: 'piped', stdout: 'piped', stderr: 'inherit',
  }).spawn()
  writer = this.process.stdin.getWriter()
  reader = this.process.stdout.getReader()
  buffer = ''
  closed = false
  async sql(statement: string): Promise<string> {
    assert.ok(!this.closed)
    const marker = uuid()
    let timer: number | undefined
    const work = async () => {
      await this.writer.write(new TextEncoder().encode(`${statement}; SELECT '${marker}';\n`))
      while (!this.buffer.includes(marker)) {
        const next = await this.reader.read()
        if (next.done) throw new Error('Own SQL connection closed before its marker')
        this.buffer += new TextDecoder().decode(next.value)
      }
      const result = this.buffer.slice(0, this.buffer.indexOf(marker)).trim()
      this.buffer = this.buffer.slice(this.buffer.indexOf(marker) + marker.length)
      return result
    }
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { try { this.process.kill('SIGTERM') } catch {} reject(new Error('Own SQL statement exceeded 15 seconds')) }, 15000)
      })])
    } finally { clearTimeout(timer) }
  }
  async close() {
    if (this.closed) return
    try { await this.sql('ROLLBACK') } catch { try { this.process.kill('SIGTERM') } catch {} }
    this.closed = true
    try { await this.writer.close() } catch {}
    try { await this.reader.cancel() } catch {}
    await this.process.status
  }
}

const sessions: SqlSession[] = []
const session = () => { const s = new SqlSession(); sessions.push(s); return s }
const { supabase } = await import('../../functions/_shared/supabase.ts')
const q = async (operation: any): Promise<any> => { const {data,error}=await operation; if(error)throw new Error(error.message); return data }
const game = uuid(), players = [uuid(),uuid()], provider = `002-atomic-${uuid()}`
const rows = players.map((player_id,i)=>({player_id,game_id:game,season_year:2781,week_number:1,points:10+i,did_not_play:false}))
const sqlString = (s: string) => "'" + s.replaceAll("'", "''") + "'"
const save = () => `SELECT public.save_game_stats_atomic('${game}', '${provider}', ${sqlString(JSON.stringify(rows))}::jsonb, true)`
const snapshot = async () => ({ game:await q(supabase.from('nba_games').select('stats_synced_at').eq('id',game).single()), stats:await q(supabase.from('player_game_stats').select('player_id,points').eq('game_id',game).order('player_id')) })
try {
  await q(supabase.from('players').insert(players.map((id,i)=>({id,first_name:'Atomic',last_name:`${game}-${i}`,position:'PG' as const,eligible_positions:['PG']}))))
  await q(supabase.from('nba_games').insert({id:game,nba_game_id:provider,season_year:2781,week_number:1,game_date:'2781-01-02',home_team:'XAT',away_team:'XAU',status:'Final'}))
  await q(supabase.rpc('save_game_stats_atomic',{p_game_id:game,p_provider_game_id:provider,p_stats:rows,p_is_final:true}))
  const a=session(), b=session(), observer=session()
  const aPid=Number(await a.sql('SELECT pg_backend_pid()')), bPid=Number(await b.sql('SELECT pg_backend_pid()'))
  const blockedByA=async()=>{
    const deadline=Date.now()+2000
    while(Date.now()<deadline){
      const observed=await observer.sql(`SELECT '${aPid}'::int = ANY(pg_blocking_pids(${bPid}))`)
      if(observed==='t')return
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    throw new Error('Own second SQL connection never visibly blocked on own first connection')
  }
  await a.sql(`BEGIN; DELETE FROM public.player_game_stats WHERE game_id='${game}' AND player_id='${players[0]}'`)
  await b.sql('BEGIN')
  const importAfterDeletion=b.sql(save())
  await blockedByA()
  await a.sql('COMMIT')
  assert.equal(await importAfterDeletion,'1')
  await b.sql('COMMIT')
  const repaired=await snapshot()
  assert.equal(repaired.stats.length,2);assert.ok(repaired.game.stats_synced_at)
  console.log(JSON.stringify({control:'delete-then-full-import',actualBlockingPids:[aPid,bPid],restoredMissingRow:true,stampPresent:true}))
  rows[0].points=20
  await a.sql('BEGIN');assert.equal(await a.sql(save()),'1')
  await b.sql('BEGIN')
  const deletionAfterImport=b.sql(`DELETE FROM public.player_game_stats WHERE game_id='${game}' AND player_id='${players[0]}'`)
  await blockedByA()
  await a.sql('COMMIT');await deletionAfterImport;await b.sql('COMMIT')
  const invalidated=await snapshot()
  assert.equal(invalidated.stats.length,1);assert.equal(invalidated.game.stats_synced_at,null)
  console.log(JSON.stringify({control:'full-import-then-delete',actualBlockingPids:[aPid,bPid],remainingRows:1,stampPresent:false}))
} finally {
  for(const s of sessions)await s.close()
  await q(supabase.from('player_game_stats').delete().eq('game_id',game))
  await q(supabase.from('nba_games').delete().eq('id',game))
  await q(supabase.from('players').delete().in('id',players))
  const cleanup=session();await cleanup.sql(`DELETE FROM private.score_input_revisions WHERE scope IN (${players.map(id=>sqlString(`player:${id}`)).join(',')})`);await cleanup.close()
  console.log(JSON.stringify({cleanup:'Exact own row IDs and all own SQL connections closed'}))
}
