import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { resolve } from 'node:path'
import http from 'node:http'
import { createClient } from '@supabase/supabase-js'

const root = resolve(process.env.DRAFT_CLOCK_EVIDENCE_DIR ?? 'evidence/round3')
mkdirSync(root, { recursive: true })
assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4badraft"$/m)
const keys = Object.fromEntries(execFileSync('supabase-go', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
for (const [key, port] of [['API_URL','57921'],['DB_URL','57922']]) {
  const u = new URL(keys[key])
  assert(['localhost','127.0.0.1'].includes(u.hostname) && u.port === port)
}
export const env = { ...process.env, SUPABASE_URL: keys.API_URL, SUPABASE_DB_URL: keys.DB_URL, PANCAKE_SUPABASE_SECRET_KEY: keys.SERVICE_ROLE_KEY, PANCAKE_TEST_API_PORT: '57921', PANCAKE_TEST_DB_PORT: '57922' }
const adminUrl = new URL(keys.DB_URL)
adminUrl.username = 'supabase_admin'
export const sql = source => execFileSync('psql', [adminUrl.toString(), '-XqAtv', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim()
export const query = source => JSON.parse(sql(source))
export const quote = value => `'${String(value).replaceAll("'", "''")}'`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const record = (name, value) => { writeFileSync(resolve(root, `${name}.json`), `${JSON.stringify(value,null,2)}\n`); console.log(JSON.stringify({ name, ...value })) }
export async function until(read, label, timeout = 75000) {
  const start = Date.now()
  while (Date.now()-start < timeout) { if (await read()) return; await delay(500) }
  throw Error(`Timeout: ${label}`)
}
let cron
export function clock(at, install = false) {
  if (install) {
    cron = query("SELECT coalesce(json_agg(j),'[]') FROM (SELECT jobname,schedule,command,active FROM cron.job) j")
    writeFileSync(resolve(root, 'cron-original.json'), JSON.stringify(cron))
    const source = readFileSync('scripts/season-sim/clock.sql', 'utf8')
    sql(source.slice(source.indexOf('BEGIN;')).replaceAll(":'sim_ms'", String(Date.parse(at))).replaceAll(":'real_ms'", String(Date.now())).replaceAll(":'rate'", '0').replaceAll(":'cap_ms'", 'NULL'))
  } else sql(`UPDATE season_sim.clock SET sim_ms=${Date.parse(at)},real_ms=${Date.now()},rate=0,cap_ms=NULL WHERE singleton`)
  assert.equal(Number(sql('SELECT extract(epoch FROM clock_timestamp())*1000')), Date.parse(at))
}
export function restoreClock() {
  if (!cron) return
  const source = readFileSync('scripts/season-sim/restore-clock.sql', 'utf8')
  sql(source.slice(source.indexOf('BEGIN;')))
  sql('SELECT cron.unschedule(jobid) FROM cron.job')
  for (const job of cron) {
    const id = sql(`SELECT cron.schedule(${quote(job.jobname)},${quote(job.schedule)},${quote(job.command)})`)
    if (!job.active) sql(`UPDATE cron.job SET active=false WHERE jobid=${Number(id)}`)
  }
  assert.equal(sql("SELECT to_regprocedure('pg_catalog.season_sim_native_now()') IS NULL"), 't')
  cron = undefined
}
export function enableExpiryCron() {
  const job = cron.find(job => job.jobname === 'nba-close-expired-nominations')
  assert(job && job.schedule === '* * * * *')
  sql(`ALTER DATABASE postgres SET app.supabase_url='http://kong:8000'; ALTER DATABASE postgres SET app.edge_internal_token='local-database-ci-token';`)
  const id = Number(sql(`SELECT cron.schedule(${quote(job.jobname)},${quote(job.schedule)},${quote(job.command)})`))
  sql("ALTER SYSTEM SET cron.launch_active_jobs='on'")
  sql('SELECT pg_reload_conf()')
  return id
}
export async function cronTick(id) {
  const count = Number(sql(`SELECT coalesce(max(runid),0) FROM cron.job_run_details WHERE jobid=${id}`))
  await until(() => Number(sql(`SELECT coalesce(max(runid),0) FROM cron.job_run_details WHERE jobid=${id} AND status='succeeded'`)) > count, 'real minute cron tick')
  return query(`SELECT row_to_json(r) FROM (SELECT runid,status,start_time,end_time,command FROM cron.job_run_details WHERE jobid=${id} ORDER BY runid DESC LIMIT 1) r`)
}
let edge
export async function startEdge() {
  const file = resolve(root, 'edge.env')
  writeFileSync(file, 'PANCAKE_EDGE_INTERNAL_TOKEN=local-database-ci-token\n')
  const fd = openSync(resolve(root, 'edge.private.log'), 'a')
  edge = spawn('supabase-go', ['functions','serve','--env-file',file], { stdio: ['ignore',fd,fd] })
  writeFileSync(resolve(root,'edge.pid'),String(edge.pid))
  closeSync(fd)
  await until(async () => { try { return (await fetch(`${keys.API_URL}/functions/v1/api/health`)).ok } catch { return false } }, 'Edge health', 60000)
  return edge.pid
}
export async function stopEdge() {
  if (!edge) return
  const child = edge
  const stopped = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([stopped, delay(5000)])
  edge = undefined
}
async function container(name) {
  assert(['supabase_db_pt4badraft','supabase_edge_runtime_pt4badraft'].includes(name))
  const body = await new Promise((resolve, reject) => {
    const request = http.get({ socketPath: process.env.DOCKER_HOST.replace('unix://',''), path: `/containers/${name}/json` }, response => {
      let body = ''; response.on('data', bytes => { body += bytes }); response.on('end', () => {
        if (response.statusCode !== 200) { reject(Error(body)); return }
        resolve(body)
      })
    }); request.on('error', reject)
  })
  const value = JSON.parse(String(body))
  assert.equal(value.Config.Labels['com.supabase.cli.project'], 'pt4badraft')
  return { id: value.Id, pid: value.State.Pid, startedAt: value.State.StartedAt }
}
export async function processes() { return { db: await container('supabase_db_pt4badraft'), edge: await container('supabase_edge_runtime_pt4badraft'), edgeCliPid: edge.pid } }
export async function restart() {
  await stopEdge()
  execFileSync('supabase-go', ['stop','--project-id','pt4badraft'], { stdio: ['ignore','ignore','pipe'] })
  execFileSync('supabase-go', ['start','-x','studio,imgproxy,vector,logflare,supavisor,postgres-meta,mailpit,edge-runtime'], { stdio: ['ignore','ignore','pipe'] })
  await startEdge()
}
export async function fixture(year = 2027) {
  const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const password = `Synthetic-${randomUUID()}!`
  const users = [], members = [randomUUID(),randomUUID()], league = randomUUID(), season = randomUUID(), players = Array.from({length:12},()=>randomUUID())
  for (let i=0;i<2;i++) {
    const email = `${randomUUID()}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.ifError(error); users.push({ id: data.user.id, email })
  }
  sql(`BEGIN; INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,playoff_entrants,playoff_round_lengths,playoff_start_week) VALUES(${quote(league)},'Synthetic clock draft',${quote(league)},${quote(users[0].id)},'offseason',15,2,ARRAY[1],24);
    INSERT INTO league_seasons(id,league_id,season_year,is_current,skipped_weeks) VALUES(${quote(season)},${quote(league)},${year},true,ARRAY[1]);
    ${members.map((m,i)=>`INSERT INTO league_members(id,league_id,user_id,role) VALUES(${quote(m)},${quote(league)},${quote(users[i].id)},'${i?'manager':'commissioner'}');`).join('')}
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id) SELECT ${quote(league)},${year},r,m,m FROM unnest(ARRAY[${members.map(quote).join(',')}]::uuid[])m CROSS JOIN generate_series(1,3)r;
    ${players.map((p,i)=>`INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(p)},'Synthetic clock',${quote(p)},'PG',ARRAY['PG'],0,${i+1});`).join('')} COMMIT;`)
  const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const signed = await client.auth.signInWithPassword({ email: users[0].email, password }); assert.ifError(signed.error)
  return { league, season, users, members, players, draft: '', token: signed.data.session.access_token }
}
export async function api(f, path, body) {
  const response = await fetch(`${keys.API_URL}/functions/v1/api${path}`, { method:'POST',headers: { 'content-type':'application/json', authorization:`Bearer ${f.token}` }, body: JSON.stringify(body) })
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data
}
export function cleanup(fixtures) {
  if (!fixtures.length) return
  for (const f of fixtures) sql(`DELETE FROM roster_transactions WHERE league_id=${quote(f.league)}; UPDATE draft_picks SET rookie_draft_id=NULL WHERE league_id=${quote(f.league)}; DELETE FROM drafts WHERE league_id=${quote(f.league)}; DELETE FROM leagues WHERE id=${quote(f.league)}`)
  for (const f of fixtures) sql(`DELETE FROM players WHERE id IN (${f.players.map(quote).join(',')}); DELETE FROM auth.users WHERE id IN (${f.users.map(u=>quote(u.id)).join(',')})`)
}
