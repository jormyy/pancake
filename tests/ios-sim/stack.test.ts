import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import { connectStack, startStack } from '../../scripts/ios-sim/stack.mjs'
import { apiUrl, project } from '../../scripts/ios-sim/common.mjs'

const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const directory = await mkdtemp(`${tmpdir()}/ios-stack-start-`)
  return { directory, run: vi.fn(), seed: vi.fn(), spawn: vi.fn(), afterCopy: vi.fn() }
})

vi.mock('../../scripts/ios-sim/common.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../../scripts/ios-sim/common.mjs')>(),
  home: fixture.directory,
  repo: path.join(fixture.directory, 'source'),
  run: fixture.run,
  ready: vi.fn(),
}))
vi.mock('../../scripts/ios-sim/build.mjs', () => ({ sourceSnapshot: async (action = (value: unknown) => value) => {
  const { cp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const lock = path.join(fixture.directory, 'snapshot.lock')
  const snapshot = path.join(fixture.directory, 'snapshot')
  await mkdir(lock)
  await writeFile(path.join(lock, 'proof'), 'locked')
  await rm(snapshot, { recursive: true, force: true })
  await cp(path.join(fixture.directory, 'source'), snapshot, { recursive: true })
  await fixture.afterCopy()
  try { return await action({ snapshot }) }
  finally { await rm(lock, { recursive: true }) }
} }))
vi.mock('../../scripts/ios-sim/seed.mjs', () => ({ seed: fixture.seed, requireCurrentSeed: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fixture.spawn }))

const stack = path.join(fixture.directory, 'stack')
const source = path.join(fixture.directory, 'source')
let processId = 2000000000

beforeEach(async () => {
  await mkdir(path.join(source, 'supabase/migrations'), { recursive: true })
  await mkdir(path.join(source, 'supabase/functions/api'), { recursive: true })
  await mkdir(path.join(source, 'types'), { recursive: true })
  await writeFile(path.join(source, 'supabase/migrations/001.sql'), 'SELECT 1;')
  await writeFile(path.join(source, 'supabase/functions/api/index.ts'), "export const value = 'first'")
  await writeFile(path.join(source, 'types/database.ts'), 'export type Database = {}')
  await writeFile(path.join(source, 'supabase/config.toml'), 'project_id = "test"\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = true\n')
  fixture.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'git') return 'supabase/migrations/001.sql'
    if (command === 'docker' && args.includes('-qAt')) return '001.sql'
    if (command === 'ps') return `supabase functions serve --workdir ${stack}`
    if (command === 'supabase' && args[0] === 'status') return JSON.stringify({ API_URL: apiUrl, ANON_KEY: 'local-public', SERVICE_ROLE_KEY: 'local-service' })
    return ''
  })
  fixture.seed.mockImplementation(async ({ directory }: { directory: string }) => {
    await mkdir(directory, { recursive: true })
    const result = { password: 'fixture-password', users: [], leagueId: 'fixture-league', rosterPlanTrade: {} }
    await writeFile(path.join(directory, 'complete.json'), JSON.stringify(result))
    return result
  })
  fixture.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: processId++, unref: vi.fn() })
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    assert.ok(Number(pid) >= 2000000000, 'Only the fixture process can be stopped')
    if (signal === 0) throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
    return true
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401 })))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  await rm(fixture.directory, { recursive: true, force: true })
})

test('start refreshes Edge and migration sources on an existing stack and keeps its data', async () => {
  await startStack()
  const data = path.join(stack, 'seed/kept.json')
  await writeFile(data, '{"owned":"fixture"}')
  await writeFile(path.join(source, 'supabase/functions/api/index.ts'), "export const value = 'second'")
  await writeFile(path.join(stack, 'supabase/functions/retired.ts'), 'stale')
  await writeFile(path.join(stack, 'supabase/migrations/retired.sql'), 'stale')
  await writeFile(path.join(stack, 'supabase/migrations/001.sql'), 'stale')
  const first = JSON.parse(await readFile(path.join(stack, 'local-stack.json'), 'utf8'))

  await startStack()

  assert.equal(await readFile(path.join(stack, 'supabase/functions/api/index.ts'), 'utf8'), "export const value = 'second'")
  assert.equal(await readFile(path.join(stack, 'supabase/migrations/001.sql'), 'utf8'), 'SELECT 1;')
  await assert.rejects(readFile(path.join(stack, 'supabase/functions/retired.ts')), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(stack, 'supabase/migrations/retired.sql')), { code: 'ENOENT' })
  assert.equal(await readFile(data, 'utf8'), '{"owned":"fixture"}')
  assert.equal(fixture.spawn.mock.calls.length, 2)
  assert.ok(vi.mocked(process.kill).mock.calls.some(([pid, signal]) => pid === first.functionsPid && signal === 'SIGTERM'))
  assert.equal(fixture.run.mock.calls.filter(([command, args]) => command === 'supabase' && args[0] === 'stop').length, 0)
})

test('only an explicit reset removes existing seed data and the owned database', async () => {
  await startStack()
  const data = path.join(stack, 'seed/kept.json')
  await writeFile(data, 'old seed')

  await startStack({ reset: true })

  await assert.rejects(readFile(data), { code: 'ENOENT' })
  assert.ok(fixture.run.mock.calls.some(([command, args]) => command === 'supabase' && args.join(' ') === `stop --workdir ${stack} --no-backup`))
  assert.equal(JSON.parse(await readFile(path.join(stack, 'local-stack.json'), 'utf8')).project, project)
})

test('an unchanged start keeps the running Edge worker', async () => {
  const first = await startStack()
  await startStack()
  assert.equal(fixture.spawn.mock.calls.length, 1)
  assert.ok(!vi.mocked(process.kill).mock.calls.some(([pid, signal]) => pid === first.functionsPid && signal === 'SIGTERM'))
  assert.equal(JSON.parse(await readFile(path.join(stack, 'local-stack.json'), 'utf8')).functionsPid, first.functionsPid)
  assert.equal(fixture.run.mock.calls.filter(([command, args]) => command === 'supabase' && args[0] === 'migration').length, 1)
})

test('an untracked migration is refused before stopping Edge or copying sources', async () => {
  const first = await startStack()
  await writeFile(path.join(source, 'supabase/migrations/002-untracked.sql'), 'SELECT 2;')
  await assert.rejects(startStack(), /Shared schema differs/)
  assert.ok(!vi.mocked(process.kill).mock.calls.some(([pid, signal]) => pid === first.functionsPid && signal === 'SIGTERM'))
  await assert.rejects(readFile(path.join(stack, 'supabase/migrations/002-untracked.sql')), { code: 'ENOENT' })
  assert.equal(fixture.spawn.mock.calls.length, 1)
})

test('migration filenames and contents both identify the existing schema', async () => {
  await startStack()
  await rm(path.join(source, 'supabase/migrations/001.sql'))
  await writeFile(path.join(source, 'supabase/migrations/002.sql'), 'SELECT 1;')
  await assert.rejects(startStack(), /Shared schema differs/)
})

test('a changed migration is refused before stopping the running Edge worker', async () => {
  const first = await startStack()
  await writeFile(path.join(source, 'supabase/migrations/001.sql'), 'SELECT 9;')
  await assert.rejects(startStack(), /Shared schema differs/)
  assert.ok(!vi.mocked(process.kill).mock.calls.some(([pid, signal]) => pid === first.functionsPid && signal === 'SIGTERM'))
  assert.equal(await readFile(path.join(stack, 'supabase/migrations/001.sql'), 'utf8'), 'SELECT 1;')
})

test('startup keeps the source snapshot locked through copying and seed reads', async () => {
  fixture.seed.mockImplementationOnce(async ({ snapshot }: { snapshot: string }) => {
    await readFile(path.join(fixture.directory, 'snapshot.lock/proof'))
    assert.equal(await readFile(path.join(stack, 'supabase/functions/api/index.ts'), 'utf8'), await readFile(path.join(snapshot, 'supabase/functions/api/index.ts'), 'utf8'))
    return { password: 'fixture-password', users: [], leagueId: 'fixture-league' }
  })
  await startStack()
})

test('schema identity comes from the copied snapshot when the checkout changes during startup', async () => {
  fixture.afterCopy.mockImplementationOnce(async () => {
    await writeFile(path.join(source, 'supabase/migrations/001.sql'), 'SELECT 9;')
  })
  await startStack()
  assert.equal(await readFile(path.join(stack, 'supabase/migrations/001.sql'), 'utf8'), 'SELECT 1;')
  await assert.rejects(startStack(), /Shared schema differs/)
})

test('capture refuses a shared stack built from different migration contents', async () => {
  await startStack()
  await writeFile(path.join(source, 'supabase/migrations/001.sql'), 'SELECT 9;')
  await assert.rejects(connectStack(), /Shared schema differs.*start --reset/)
})

test('capture refuses missing or extra applied migrations before reading fixtures', async () => {
  await startStack()
  const original = fixture.run.getMockImplementation()!
  for (const applied of ['', '001.sql\n002.sql', '002.sql']) {
    fixture.run.mockImplementation(async (command: string, args: string[]) =>
      command === 'docker' && args.includes('-qAt') ? applied : original(command, args))
    await assert.rejects(connectStack(), /Applied migrations differ.*start --reset/)
  }
})

test('capture reuses a shared stack only when its source and applied migrations match', async () => {
  await startStack()
  const connected = await connectStack()
  assert.equal(connected.project, project)
  assert.ok(fixture.run.mock.calls.some(([command, args]) => command === 'docker' && args.includes('-qAt')))
})

test('capture refuses a separate stack with missing migrations before seeding', async () => {
  const original = fixture.run.getMockImplementation()!
  fixture.run.mockImplementation(async (command: string, args: string[]) =>
    command === 'docker' && args.includes('-qAt') ? '' : original(command, args))
  await assert.rejects(connectStack(source), /Applied migrations differ/)
  assert.equal(fixture.seed.mock.calls.length, 0)
})
