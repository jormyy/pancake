import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { assertTarget, miniRoot } from './common.mjs'

const cli = path.join(miniRoot, 'tools/supabase-go')
const container = 'supabase_db_pt0493sim'

async function docker(method, resource, body) {
  assert.ok(resource === `/containers/${container}/json` || resource === `/containers/${container}/exec` || /^\/exec\/[a-f0-9]+\/(start|json)$/.test(resource))
  const socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '')
  assert.equal(socketPath, path.join(miniRoot, '../../lima/pt0493/sock/docker.sock'))
  return await new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: resource, headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const bytes = Buffer.concat(chunks)
        if (res.statusCode >= 300) reject(new Error(`Own-container Docker request failed: ${res.statusCode} ${bytes.toString()}`))
        else resolve(bytes)
      })
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

export function localKeys() {
  const output = execFileSync(cli, ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const values = Object.fromEntries(output.split('\n').flatMap(line => {
    const match = /^([A-Z_]+)="(.*)"$/.exec(line)
    return match ? [[match[1], match[2]]] : []
  }))
  assertTarget(values.API_URL, 'api')
  assertTarget(values.DB_URL, 'db')
  return values
}

export async function sql(statement) {
  assertTarget('postgresql://postgres@127.0.0.1:56222/postgres', 'db')
  const inspected = JSON.parse((await docker('GET', `/containers/${container}/json`)).toString())
  assert.equal(inspected.Name, `/${container}`)
  assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(binding => binding.HostPort === '56222'))
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
  const config = path.join(process.cwd(), 'supabase/config.toml')
  let contents = await readFile(config, 'utf8')
  contents = contents.replace(/^project_id = .*$/m, 'project_id = "pt0493sim"').replace(/\b543(\d\d)\b/g, '562$1').replace('inspector_port = 8083', 'inspector_port = 56283')
  contents = contents.replace(/(\[realtime\]\s*enabled = )false/, '$1true').replace(/(\[storage\]\s*enabled = )false/, '$1true')
  contents = contents.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1false').replace(/(\[db.seed\][\s\S]*?enabled = )(?:true|false)/, '$1false')
  await writeFile(config, contents)
  execFileSync(cli, ['start', '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'], { stdio: ['ignore', 'ignore', 'inherit'] })
  await sql("ALTER SYSTEM SET cron.launch_active_jobs = 'off'")
  await sql('SELECT pg_reload_conf()')
  await writeFile(config, contents.replace(/(\[db.migrations\][\s\S]*?enabled = )(?:true|false)/, '$1true'))
  execFileSync(cli, ['migration', 'up', '--local'], { stdio: 'inherit' })
  await sql('SELECT cron.unschedule(jobid) FROM cron.job')
  console.log(JSON.stringify({ event: 'stack-ready', project: 'pt0493sim', cronJobs: Number(await sql('SELECT count(*) FROM cron.job')) }))
}
