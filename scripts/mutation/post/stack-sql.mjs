import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { homedir } from 'node:os'
import './lane.mjs'

const container = 'supabase_db_pt4bapost'

async function docker(method, resource, body) {
  assert.ok(resource === `/containers/${container}/json` || resource === `/containers/${container}/exec` || /^\/exec\/[a-f0-9]+\/(start|json)$/.test(resource))
  const socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '')
  assert.equal(socketPath, path.join(homedir(), 'pancake-t_4ba51e0d/lima/pt4ba/sock/docker.sock'))
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

export async function sql(statement) {
  const inspected = JSON.parse((await docker('GET', `/containers/${container}/json`)).toString())
  assert.equal(inspected.Name, `/${container}`)
  assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(binding => binding.HostPort === '57422'))
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

