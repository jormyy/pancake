import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a2')
assert.equal(process.cwd(), path.join(lane, 'repo'))
assert.equal(process.versions.node.split('.')[0], '22')
const measured = process.argv.includes('--measure')
const tracked = process.argv.includes('--invocation')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const label = option('label') ?? 'http'
const files = (option('files') ?? '').split(',').filter(Boolean)
const definitions = {
  baseline: files.map(file => execFileSync('git', ['show', `952580ce:supabase/sql/functions/by-name/${file}`], { encoding: 'utf8' })).join('\n'),
  candidate: (await Promise.all(files.map(file => readFile(`supabase/sql/functions/by-name/${file}`, 'utf8')))).join('\n'),
}
const sql = input => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafablea2', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: `SET pg_stat_statements.track='none';${input}`, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }).trim()
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const fixtureManifest = path.join(lane, 'http-fixture.json')
try { await readFile(fixtureManifest); execFileSync('node', ['tests/db/roster-actions-clean-http.mjs'], { stdio: 'inherit' }) } catch (error) { if (error.code !== 'ENOENT') throw error }
const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(new URL(status.API_URL).hostname, '127.0.0.1')
assert.equal(new URL(status.API_URL).port, '64421')
const key = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY
const publicKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY
assert.ok(key && publicKey)
const admin = createClient(status.API_URL, key, { auth: { persistSession: false, autoRefreshToken: false } })
const environment = path.join(lane, 'http-local.env')
await writeFile(environment, `PANCAKE_SUPABASE_SECRET_KEY=${key}\nPANCAKE_EDGE_INTERNAL_TOKEN=roster-actions-local\n`)
const configFile = 'supabase/config.toml'
const originalConfig = await readFile(configFile,'utf8')
await writeFile(configFile,originalConfig.replace('policy = "per_worker"', 'policy = "oneshot"').replace('[functions.api]','[functions.api]\nentrypoint = "../tests/db/roster-actions-edge/api/index.mjs"').replace('[functions.process-waivers]','[functions.process-waivers]\nentrypoint = "../tests/db/roster-actions-edge/worker/index.mjs"'))
const log = openSync(path.join(lane, 'evidence/http-edge.log'), 'w')
const server = spawn('supabase', ['functions', 'serve', '--env-file', environment], { stdio: ['ignore', log, log] })
const users = []
const reportFile = path.join(lane, `evidence/${label}-${measured ? 'samples' : 'verify'}.json`)
const reports = []
if (process.argv.includes('--resume')) {
  const saved = JSON.parse(await readFile(reportFile, 'utf8'))
  const pairs = new Map()
  for (const row of saved) {
    const key = `${row.round}/${row.manager}/${row.name}`
    const variants = pairs.get(key) ?? new Set()
    variants.add(row.variant)
    pairs.set(key, variants)
  }
  reports.push(...saved.filter(row => pairs.get(`${row.round}/${row.manager}/${row.name}`).size === 2))
}
const completedPairs = new Set(reports.map(row => `${row.round}/${row.manager}/${row.name}`))
const invocations = []
const joinLeague = randomUUID()
const names = ['submit','edit','cancel','reorder','to-ir','from-ir','to-taxi-rejected','from-taxi','worker','add-active','add-ir','add-taxi','drop','drop-and-add','activate-ir-overflow-drop','activate-ir-overflow-ir','activate-taxi-overflow-drop','activate-taxi-overflow-ir','activate-ir-lineup-drop','activate-taxi-lineup-ir','commissioner-faab','commissioner-weekly-add','invite-join'].filter(name => !option('case') || option('case').split(',').includes(name))
const players = Array.from({ length: 9 }, randomUUID)
let league
let serverClosed = false
server.on('exit', () => { serverClosed = true })
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const call = async (client, name, body) => {
  const result = await client.rpc(name, body)
  assert.ifError(result.error)
  return result.data
}
const responseBodies = new Map()
const deferred = JSON.parse(sql("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'date',process_date)),'[]') FROM public.waiver_claims WHERE status='pending';"))
await writeFile(fixtureManifest, JSON.stringify(deferred))
try {
  sql("UPDATE public.waiver_claims SET process_date=current_date+100 WHERE status='pending';");
  sql("ALTER DATABASE postgres SET app.supabase_url='http://127.0.0.1:64421';ALTER DATABASE postgres SET app.edge_internal_token='roster-actions-local';")
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverClosed) throw new Error('Local Edge server exited before becoming ready')
    try { ready = (await fetch(`${status.API_URL}/functions/v1/api/health`, { headers: { apikey: publicKey }, signal: AbortSignal.timeout(2000) })).ok } catch {}
    if (ready) break
    await pause(1000)
  }
  assert.ok(ready, 'Local Edge server did not become ready')
  for (let index = 0; index < 3; index++) {
    const email = `roster-http-${randomUUID()}@example.test`
    const password = `Local-${randomUUID()}`
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.ifError(created.error)
    users.push({ id: created.data.user.id })
    const client = createClient(status.API_URL, publicKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set('x-request-id',randomUUID()); return fetch(input,{ ...init,headers }) } } })
    const signed = await client.auth.signInWithPassword({ email, password })
    assert.ifError(signed.error)
    users[index].client = client
    users[index].token = signed.data.session.access_token
  }
  const created = await call(users[0].client, 'create_league', { p_name: 'Roster HTTP cost', p_team_name: 'HTTP A' })
  league = created.id
  const invite = sql(`SELECT invite_code FROM public.leagues WHERE id=${literal(league)};`)
  for (const user of users.slice(1)) await call(user.client, 'join_league_by_invite_code', { p_invite_code: invite, p_team_name: `HTTP ${user.id.slice(0, 8)}` })
  const season = sql(`SELECT id FROM public.league_seasons WHERE league_id=${literal(league)} AND is_current;`)
  sql(`UPDATE public.league_seasons SET season_year=9882 WHERE id=${literal(season)};
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9882,1,current_date-2,current_date+4);
    UPDATE public.leagues SET status='active',waiver_mode='faab',weekly_add_limit=20,roster_size=12,ir_slots=4,taxi_slots=4 WHERE id=${literal(league)};
    INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team,injury_status,years_exp,career_regular_season_games,nba_draft_number)
      VALUES ${players.map((player, index) => `(${literal(player)},'Roster HTTP','${index}','PG',ARRAY['PG'],'ZRA','Out',0,0,1)`).join(',')};`)
  for (let index = 0; index < users.length; index++) {
    const user = users[index]
    user.member = sql(`SELECT id FROM public.league_members WHERE league_id=${literal(league)} AND user_id=${literal(user.id)};`)
    user.roster = randomUUID()
    user.target = randomUUID()
    sql(`INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${literal(user.roster)},${literal(league)},${literal(season)},${literal(user.member)},${literal(players[index * 3])},'draft');`)
  }
  const rounds = measured ? 5 : 1
  for (let round = 0; round < rounds; round++) {
      for (let manager = 0; manager < users.length; manager++) for (const name of names) for (const variant of ['baseline', 'candidate']) {
        if (process.argv.includes('--rotate-manager') && manager !== round % users.length) continue
        if (completedPairs.has(`${round}/${manager + 1}/${name}`)) continue
        const user = users[manager]
        const invocation = tracked && name === 'worker' ? randomUUID() : null
        if (invocation) invocations.push(invocation)
        const claim = randomUUID()
        const other = randomUUID()
        const requestId = `${String(manager + 1).padStart(8, '0')}-0000-4000-8000-${String(round * 100 + names.indexOf(name)).padStart(12, '0')}`
        sql(`BEGIN;${definitions[variant]}
          DELETE FROM public.roster_transactions WHERE member_id=${literal(user.member)} AND league_id=${literal(league)};
          DELETE FROM public.waiver_wire_log WHERE league_id=${literal(league)};
          UPDATE public.faab_balances SET balance=100 WHERE member_id=${literal(user.member)};
          UPDATE public.weekly_add_counts SET add_count=0 WHERE member_id=${literal(user.member)};
          DELETE FROM public.roster_players WHERE member_id=${literal(user.member)} AND player_id=${literal(players[manager * 3 + 1])};
          DELETE FROM public.waiver_claims WHERE league_id=${literal(league)} AND member_id=${literal(user.member)};
          DELETE FROM public.league_member_taxi_exits WHERE league_id=${literal(league)};
          DELETE FROM public.league_player_taxi_exits WHERE league_id=${literal(league)};
          DELETE FROM private.request_receipts WHERE request_id=${literal(requestId)};
          INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${literal(user.roster)},${literal(league)},${literal(season)},${literal(user.member)},${literal(players[manager * 3])},'draft') ON CONFLICT DO NOTHING;
          UPDATE public.roster_players SET is_on_ir=${name === 'from-ir'},is_on_taxi=false WHERE id=${literal(user.roster)};
          ${['edit', 'cancel', 'reorder', 'worker'].includes(name) ? `INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,claim_order,bid_amount)
            VALUES(${literal(claim)},${literal(league)},${literal(season)},${literal(user.member)},${literal(players[manager * 3 + 1])},${manager + 1},current_date+2,1,10);` : ''}
          ${name === 'worker' ? `UPDATE public.waiver_claims SET process_date=current_date-1 WHERE id=${literal(claim)};UPDATE public.faab_balances SET balance=100 WHERE member_id=${literal(user.member)};UPDATE public.weekly_add_counts SET add_count=0 WHERE member_id=${literal(user.member)};` : ''}
          ${name === 'reorder' ? `INSERT INTO public.waiver_claims(id,league_id,league_season_id,member_id,player_id,priority_at_submission,process_date,claim_order,bid_amount)
            VALUES(${literal(other)},${literal(league)},${literal(season)},${literal(user.member)},${literal(players[manager * 3 + 2])},${manager + 1},current_date+2,2,10);` : ''}
          ${name.startsWith('activate-') || name === 'from-taxi' ? `${name.includes('taxi') ? `SELECT private.authorize_taxi_acquisition(${literal(league)},${literal(season)},${literal(user.member)},${literal(players[manager * 3 + 1])},'draft',${literal(user.target)});` : ''}INSERT INTO public.roster_players(id,league_id,league_season_id,member_id,player_id,is_on_ir,is_on_taxi,acquired_via) VALUES(${literal(user.target)},${literal(league)},${literal(season)},${literal(user.member)},${literal(players[manager * 3 + 1])},${name.includes('ir-')},${name.includes('taxi')},'draft');` : ''}
          ${name === 'invite-join' ? `DELETE FROM public.leagues WHERE id=${literal(joinLeague)};INSERT INTO public.leagues(id,name,slug,commissioner_id,status,invite_code,team_limit) VALUES(${literal(joinLeague)},'HTTP invite',${literal(joinLeague)},${literal(users[0].id)},'setup','ABCDEF0123456789',12);INSERT INTO public.league_seasons(league_id,season_year,is_current) VALUES(${literal(joinLeague)},9882,true);` : ''}
          ${invocation ? `WITH work AS (
            INSERT INTO private.work_items(kind,key,payload,status,lease_token,lease_until,invocation_key,attempts)
            VALUES('process-waivers',${literal(invocation)},jsonb_build_object('roster_actions',${literal(invocation)}),'running',gen_random_uuid(),now()+interval '5 minutes',${literal(invocation)},1)
            RETURNING id,lease_token)
          INSERT INTO public.edge_invocations(function_name,invocation_key,work_item_id,work_lease_token)
          SELECT 'process-waivers',${literal(invocation)},id,lease_token FROM work;` : ''}
          SELECT extensions.pg_stat_statements_reset();COMMIT;`)
        const p = players[manager * 3 + 1]
        const activation = { p_activate_roster_player_id:user.target,p_activate_source:name.includes('taxi')?'taxi':'ir',p_free_roster_player_id:user.roster,p_free_action:name.endsWith('-ir')?'ir':'drop' }
        const direct = name.startsWith('add-') ? ['add_free_agent_atomic',{p_member_id:user.member,p_league_id:league,p_player_id:p,p_to_ir:name==='add-ir',p_to_taxi:name==='add-taxi'}]
          : name==='drop' ? ['drop_player_atomic',{p_roster_player_id:user.roster}]
          : name==='drop-and-add' ? ['drop_and_add_free_agent_atomic',{p_roster_player_id:user.roster,p_member_id:user.member,p_league_id:league,p_player_id:p}]
          : name.startsWith('activate-') ? [name.includes('lineup')?'activate_roster_player_with_lineup_atomic':'activate_roster_player_with_overflow_atomic',{...activation,...(name.includes('lineup')?{p_member_id:user.member,p_league_id:league,p_league_season_id:season,p_game_date:new Date().toISOString().slice(0,10),p_week_number:1,p_slot_type:'PG'}:{})}]
          : name==='commissioner-faab' ? ['commissioner_adjust_faab_balance_atomic',{p_league_id:league,p_member_id:user.member,p_balance:85}]
          : name==='commissioner-weekly-add' ? ['commissioner_override_weekly_add_count_atomic',{p_league_id:league,p_member_id:user.member,p_add_count:2}]
          : name==='invite-join' ? ['join_league_by_invite_code',{p_invite_code:'ABCDEF0123456789',p_team_name:'Joined HTTP'}] : null
        const route = direct ? `/rest/v1/rpc/${direct[0]}` : name==='worker' ? '/functions/v1/process-waivers' : `/functions/v1/api${name==='submit'?'/waivers/claims':['to-ir','from-ir'].includes(name)?'/league/roster/ir':['to-taxi-rejected','from-taxi'].includes(name)?'/league/roster/taxi':`/waivers/claims/${name==='reorder'?other:claim}/${name}`}`
        const body = direct ? direct[1] : name==='submit' ? {leagueId:league,memberId:user.member,playerId:p,bidAmount:10} : ['to-ir','from-ir'].includes(name) ? {rosterPlayerId:user.roster,isOnIR:name==='to-ir'} : ['to-taxi-rejected','from-taxi'].includes(name) ? {rosterPlayerId:name==='from-taxi'?user.target:user.roster,isOnTaxi:name==='to-taxi-rejected'} : {memberId:user.member,bidAmount:20,direction:'up'}
        const response = await fetch(`${status.API_URL}${route}`, {method:'POST',headers:{apikey:publicKey,authorization:`Bearer ${(name.startsWith('commissioner-')?users[0]:user).token}`,'content-type':'application/json','x-request-id':requestId,'x-roster-case':`${round}/${manager+1}/${name}/${variant}`,...(name==='worker'?{'x-internal-function-token':'roster-actions-local',...(invocation?{'x-pancake-invocation-id':invocation,'x-pancake-work-id':'local-roster-actions'}:{})}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
        const text = await response.text()
        assert.equal(response.status, name==='to-taxi-rejected' || name.startsWith('add-') || name==='drop-and-add' ? 400 : direct && (name==='drop' || name.startsWith('activate-')) ? 204 : 200, `${name}: ${text}`)
        if (name === 'worker') assert.deepEqual(JSON.parse(text), {ok:true,processed:1})
        const identity = `${round}/${manager}/${name}`
        if (responseBodies.has(identity)) assert.equal(text, responseBodies.get(identity), identity)
        else responseBodies.set(identity, text)
        const statements = JSON.parse(sql("SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT query,toplevel,calls,total_exec_time,total_plan_time,shared_blks_hit,shared_blks_read,rows,wal_bytes FROM extensions.pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%') s;"))
        const top = statements.filter(statement => statement.toplevel)
        const bookkeeping = top.filter(statement => /start_edge_invocation|finish_edge_invocation|renew_work_lease/.test(statement.query))
        reports.push({ name, invocation: Boolean(invocation), bookkeeping: { calls: bookkeeping.reduce((sum, row) => sum + row.calls, 0), ms: bookkeeping.reduce((sum, row) => sum + row.total_exec_time + row.total_plan_time, 0), buffers: bookkeeping.reduce((sum, row) => sum + row.shared_blks_hit + row.shared_blks_read, 0), wal: bookkeeping.reduce((sum, row) => sum + Number(row.wal_bytes), 0) }, manager: manager + 1, round, variant, status: response.status, responseBytes: Buffer.byteLength(text), statements, calls: top.reduce((sum, statement) => sum + statement.calls, 0), dbMs: top.reduce((sum, statement) => sum + statement.total_exec_time + statement.total_plan_time, 0), buffers: top.reduce((sum, statement) => sum + statement.shared_blks_hit + statement.shared_blks_read, 0), wal: top.reduce((sum, statement) => sum + Number(statement.wal_bytes), 0) })
        await writeFile(reportFile, JSON.stringify(reports))
        console.log(`PASS HTTP ${name}/${manager + 1} ${variant}: ${response.status}, ${Buffer.byteLength(text)} bytes`)
      }
  }
} finally {
  try {
  if (invocations.length) sql(`DELETE FROM public.league_events WHERE kind='work.succeeded' AND detail->>'key' IN(${invocations.map(literal).join(',')});DELETE FROM public.sync_runs WHERE id IN(SELECT sync_run_id FROM public.edge_invocations WHERE invocation_key IN(${invocations.map(literal).join(',')}));DELETE FROM public.edge_invocations WHERE invocation_key IN(${invocations.map(literal).join(',')});DELETE FROM private.work_items WHERE invocation_key IN(${invocations.map(literal).join(',')});`)
  if (league) sql(`${definitions.candidate}DELETE FROM private.request_receipts WHERE actor IN(${users.map(user => literal(user.id)).join(',')});DELETE FROM public.leagues WHERE id IN(${literal(league)},${literal(joinLeague)});DELETE FROM public.players WHERE id IN(${players.map(literal).join(',')});DELETE FROM public.season_weeks WHERE season_year=9882;`)
  for (const user of users) { const result = await admin.auth.admin.deleteUser(user.id); assert.ifError(result.error) }
  if (deferred.length) sql(`UPDATE public.waiver_claims claim SET process_date=original.date FROM jsonb_to_recordset(${literal(JSON.stringify(deferred))}::jsonb) AS original(id uuid,date date) WHERE claim.id=original.id;`)
  await rm(fixtureManifest, { force: true })
  } finally {
  server.kill('SIGTERM')
  for (let attempt = 0; attempt < 100 && !serverClosed; attempt++) await pause(100)
  if (!serverClosed) server.kill('SIGKILL')
  closeSync(log)
  const byteRecords = (await readFile(path.join(lane, 'evidence/http-edge.log'),'utf8')).split('\n').flatMap(line => { const index=line.indexOf('{"event":"roster-actions-db-bytes"');if(index<0) return [];try {return [JSON.parse(line.slice(index))]} catch {return []} })
  for (const report of reports) {
    const records = byteRecords.filter(record => record.case===`${report.round}/${report.manager}/${report.name}/${report.variant}`)
    if (records.length || report.dbResponseBytes === undefined) {
      report.dbResponses = records
      report.dbResponseBytes = records.length ? records.reduce((sum,record) => sum+record.bytes,0) : report.responseBytes
    }
  }
  await writeFile(reportFile,JSON.stringify(reports))
  await rm(environment, { force: true })
  await writeFile(configFile,originalConfig)
  }
}
