import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
const supabase = createClient(url, process.env.PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const originalDirectory = process.cwd()
const artifacts = await mkdtemp(join(tmpdir(), 'pancake-waiver-soak-'))
await mkdir(join(artifacts, 'tests/e2e'), { recursive: true })
await copyFile(join(originalDirectory, 'tests/e2e/performance-budgets.json'), join(artifacts, 'tests/e2e/performance-budgets.json'))
process.chdir(artifacts)
const { assertWaiverProcessingScenario } = await import('./soak-waiver-push.mjs')
const { createScenarioResourceOwner } = await import('./scenario-resource-owner.mjs')
const owner = createScenarioResourceOwner('isolated waiver clock')
const users = []
const server = createServer(async (_request, response) => {
  try {
    const result = await fetch(`${url}/functions/v1/process-waivers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-function-token': process.env.PANCAKE_EDGE_INTERNAL_TOKEN },
      body: '{}',
    })
    response.writeHead(result.status, { 'content-type': 'application/json' })
    response.end(await result.text())
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})
try {
  for (let index = 0; index < 4; index += 1) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: `waiver-soak-${randomUUID()}@example.test`, password: randomUUID(), email_confirm: true,
    })
    if (error) throw error
    users.push(data.user)
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(null)))
  const address = server.address()
  assert(address && typeof address === 'object')
  const result = await assertWaiverProcessingScenario({ supabase,
    env: { apiBaseUrl: `http://127.0.0.1:${address.port}`, e2eAdminSecret: 'local-test' },
    state: { users, password: 'local-test', runId: randomUUID() }, season: 590, resourceOwner: owner,
  })
  assert.deepEqual(result.failures, [])
  assert.equal(result.claimRows.length, 4)
  console.log('PASS: 4 release-soak claims reach their expected terminal states')
} finally {
  await new Promise(resolve => server.close(() => resolve(null)))
  await owner.dispose()
  for (const user of users) {
    const { error } = await supabase.auth.admin.deleteUser(user.id)
    if (error) throw error
  }
  process.chdir(originalDirectory)
  await rm(artifacts, { recursive: true, force: true })
}
