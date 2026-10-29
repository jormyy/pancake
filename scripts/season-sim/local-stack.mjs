import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertTarget, config, databaseUrl, miniRoot } from './common.mjs'
import { mergeCronCatalog } from './cron.mjs'
import { createSqlSession } from './sql-session.mjs'

const { cli, container } = config
let checkedNativeTarget = false
let nativeSession

async function docker(method, resource, body) {
  assert.ok(resource === `/containers/${container}/json` || resource === `/containers/${container}/exec` || /^\/exec\/[a-f0-9]+\/(start|json)$/.test(resource) || resource === `/volumes/${container}`)
  const socketPath = config.socket
  assert.ok(socketPath, 'Set DOCKER_HOST to the task-local Unix socket')
  return await new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: resource, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const bytes = Buffer.concat(chunks)
        if (res.statusCode >= 300) reject(Object.assign(new Error(`Own-container Docker request failed: ${res.statusCode} ${bytes.toString()}`), { statusCode: res.statusCode }))
        else resolve(bytes)
      })
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

export function localKeys() {
  const output = execFileSync(cli, ['status', '-o', 'env', '--workdir', path.join(miniRoot, 'repo')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const values = Object.fromEntries(output.split('\n').flatMap(line => {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line)
    return match ? [[match[1], match[2]]] : []
  }))
  assertTarget(values.API_URL, 'api')
  assertTarget(values.DB_URL, 'db')
  return values
}

export function databaseEnvironment(target = assertTarget(localKeys().DB_URL, 'db')) {
  assertTarget(target.href, 'db')
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PGSERVICE', 'PGSERVICEFILE'].includes(key)))
  return { ...inherited, PGHOST: '127.0.0.1', PGHOSTADDR: '127.0.0.1', PGPORT: target.port, PGUSER: 'supabase_admin', PGDATABASE: 'postgres', PGPASSWORD: decodeURIComponent(target.password), PGPASSFILE: '/dev/null', PGSSLMODE: 'disable' }
}

export async function sql(statement) {
  assertTarget(databaseUrl, 'db')
  if (!checkedNativeTarget) {
    const inspected = JSON.parse((await docker('GET', `/containers/${container}/json`)).toString())
    assert.equal(inspected.Name, `/${container}`)
    assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(binding => binding.HostPort === String(config.ports.db)))
    checkedNativeTarget = true
  }
  if (process.env.SUPABASE_DB_URL) {
    const target = assertTarget(process.env.SUPABASE_DB_URL, 'db')
    nativeSession ??= createSqlSession(process.env.SEASON_SIM_PSQL ?? (process.env.SEASON_SIM_TWO_DAY === '1' ? 'psql' : path.resolve(miniRoot, '../../tools/pg/bin/psql')), databaseEnvironment(target))
    return nativeSession.query(statement)
  }
  const command = statement.length > 32000
    ? ['sh', '-c', 'printf %s "$@" | base64 -d | psql -XqAt -U supabase_admin -d postgres --set ON_ERROR_STOP=1', 'season-sim-sql', ...Buffer.from(statement).toString('base64').match(/.{1,60000}/g)]
    : ['psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '--set', 'ON_ERROR_STOP=1', '-c', statement]
  const exec = JSON.parse((await docker('POST', `/containers/${container}/exec`, { AttachStdout: true, AttachStderr: true, Cmd: command })).toString())
  const bytes = await docker('POST', `/exec/${exec.Id}/start`, { Detach: false, Tty: false })
  let stdout = '', stderr = ''
  for (let offset = 0; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset + 4)
    const text = bytes.subarray(offset + 8, offset + 8 + size).toString()
    if (bytes[offset] === 1) stdout += text
    else stderr += text
    offset += 8 + size
  }
  const result = JSON.parse((await docker('GET', `/exec/${exec.Id}/json`)).toString())
  if (result.ExitCode !== 0) throw new Error(stderr || stdout)
  return stdout.trim()
}

export async function sqlJson(statement, context, execute = sql) {
  let output
  try {
    output = await execute(statement)
  } catch (cause) {
    throw new Error(`${context}: SQL read failed`, { cause })
  }
  assert.ok(typeof output === 'string' && output.trim().length > 0, `${context}: empty SQL output`)
  try {
    return JSON.parse(output)
  } catch (cause) {
    throw new Error(`${context}: invalid SQL JSON (${Buffer.byteLength(output)} bytes)`, { cause })
  }
}

export async function setupStack() {
  assert.equal(await realpath(process.cwd()), path.join(miniRoot, 'repo'), 'Stack setup runs only in the mini lane checkout')
  const configFile = path.join(process.cwd(), 'supabase/config.toml')
  let contents = await readFile(configFile, 'utf8')
  contents = contents.replace(/^project_id = .*$/m, `project_id = "${config.project}"`).replace(/\b543(\d\d)\b/g, `${config.prefix}$1`).replace('inspector_port = 8083', `inspector_port = ${config.ports.inspector}`)
  contents = contents.replace(/(\[realtime\]\s*enabled = )false/, '$1true').replace(/(\[storage\]\s*enabled = )false/, '$1true')
  contents = contents.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1false').replace(/(\[db.seed\][\s\S]*?enabled = )(?:true|false)/, '$1false')
  await writeFile(configFile, contents)
  execFileSync(cli, ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'], { stdio: ['ignore', 'ignore', 'inherit'] })
  await sql("ALTER SYSTEM SET cron.launch_active_jobs = 'off'")
  await sql('SELECT pg_reload_conf()')
  await writeFile(configFile, contents.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1true'))
  execFileSync(cli, ['migration', 'up', '--local', '--include-all'], { stdio: 'inherit' })
  const catalogFile = path.join(miniRoot, 'cron-jobs.json')
  const installed = JSON.parse(await sql("SELECT coalesce(json_agg(r ORDER BY jobname),'[]') FROM (SELECT jobname,schedule,command FROM cron.job) r"))
  let retained = []
  try { retained = JSON.parse(await readFile(catalogFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await writeFile(catalogFile, JSON.stringify(mergeCronCatalog(installed, retained)))
  await writeFile(path.join(miniRoot, 'cron-catalog-evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), installedRows: installed.length, retainedRows: retained.filter(row => !installed.some(job => job.jobname === row.jobname)).length, scope: 'Installed migration cron rows override the earlier captured catalog; disabled jobs are retained as pinned catalog evidence.' }))
  await sql('SELECT cron.unschedule(jobid) FROM cron.job')
  console.log(JSON.stringify({ event: 'stack-ready', project: config.project, cronJobs: Number(await sql('SELECT count(*) FROM cron.job')) }))
}

export async function clearOwnBackup(request = docker) {
  let volume
  try { volume = JSON.parse((await request('GET', `/volumes/${container}`)).toString()) }
  catch (error) { if (error.statusCode === 404) return false; throw error }
  assert.equal(volume.Name, container, 'Backup name must match the configured lane')
  assert.equal(volume.Labels?.['com.supabase.cli.project'], config.project, 'Backup label must match the configured project')
  await request('DELETE', `/volumes/${container}`)
  return true
}
