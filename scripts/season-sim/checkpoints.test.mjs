import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as checkpoints from './checkpoints.mjs'
import {miniRoot} from './common.mjs'

test('two-season snapshots cannot use the running replay folder',()=>{
  const saved={mode:process.env.SEASON_SIM_MODE,root:process.env.SEASON_SIM_SNAPSHOT_ROOT}
  try{
    process.env.SEASON_SIM_MODE='two-season'
    delete process.env.SEASON_SIM_SNAPSHOT_ROOT
    assert.equal(checkpoints.snapshotRoot(),path.resolve(miniRoot,'../../shared/sim2/snapshots'))
    process.env.SEASON_SIM_SNAPSHOT_ROOT=path.resolve(miniRoot,'../../shared/sim/snapshots')
    assert.throws(()=>checkpoints.snapshotRoot(),/running replay/)
    assert.ok(checkpoints.validSnapshotName('season-2026-automatic-champion'))
    assert.equal(checkpoints.validSnapshotName('../automatic-champion'),false)
  }finally{
    if(saved.mode==null)delete process.env.SEASON_SIM_MODE;else process.env.SEASON_SIM_MODE=saved.mode
    if(saved.root==null)delete process.env.SEASON_SIM_SNAPSHOT_ROOT;else process.env.SEASON_SIM_SNAPSHOT_ROOT=saved.root
  }
})

test('snapshots wait for API-created dispatch and the worker response to finish', async () => {
  const states = [
    { workers: [{ id: 1, function_name: 'lineup-optimizer', worker_status: 'pending' }], runtime: { active: 0, fetches: 0 } },
    { workers: [], runtime: { active: 1, fetches: 1 } },
    { workers: [], runtime: { active: 0, fetches: 0 } },
  ]
  let time = 0
  const result = await checkpoints.waitForSnapshotWorkers({ read: async () => states.shift(), now: () => time, wait: async ms => { time += ms } })
  assert.deepEqual(result, { polls: 3, waitedMs: 20, advancedMs: 0 })
})

test('snapshot preparation uses the cadence driver for a sleeping worker deadline', async () => {
  const calls = []
  const states = [
    { workers: [{ id: 1265, function_name: 'sync-projections' }], runtime: { active: 1, sleeping: 1, fetches: 0, nextAt: 11000, at: '1970-01-01T00:00:00Z' } },
    { workers: [], runtime: { active: 0, sleeping: 0, fetches: 0 } },
  ]
  const result = await checkpoints.waitForSnapshotWorkers({ read: async () => states.shift(), now: () => 0, advance: async at => { calls.push(at) } })
  assert.deepEqual(calls, [11000])
  assert.equal(result.advancedMs, 11000)
})

test('snapshots fail with the pending worker identity when paused workers never settle', async () => {
  let time = 0
  await assert.rejects(checkpoints.waitForSnapshotWorkers({
    read: async () => ({ workers: [{ id: 19, function_name: 'lineup-optimizer', worker_status: 'pending' }], runtime: { active: 0, fetches: 0 } }),
    now: () => time, wait: async ms => { time += ms }, timeoutMs: 20,
  }), /Snapshot workers did not settle.*19.*lineup-optimizer/)
})

test('snapshot preparation lets an already-due timer fire without moving business time', async () => {
  let time = 0
  const states = [
    { workers: [{ id: 1 }], runtime: { active: 1, sleeping: 1, fetches: 0, nextAt: 0, at: '1970-01-01T00:00:00Z' } },
    { workers: [], runtime: { active: 0, fetches: 0 } },
  ]
  const result = await checkpoints.waitForSnapshotWorkers({ read: async () => states.shift(), now: () => time, wait: async ms => { time += ms }, advance: async () => assert.fail('An already-due timer must not advance the clock') })
  assert.deepEqual(result, { polls: 2, waitedMs: 10, advancedMs: 0 })
})

test('snapshot writer waits before dumping an API-created pending invocation', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'season-sim-worker-')))
  try {
    await mkdir(path.join(directory, 'repo'))
    await mkdir(path.join(directory, 'state'))
    await mkdir(path.join(directory, 'evidence'))
    await mkdir(path.join(directory, 'fixtures'))
    await writeFile(path.join(directory, 'state/clock.json'), JSON.stringify({ rate: 0, simMs: 1 }))
    await writeFile(path.join(directory, 'evidence/upstream-summary.json'), '{}')
    await writeFile(path.join(directory, 'fixtures/manifest.jsonl'), '')
    const fakeStack = `
      let polls = 0
      export const sql = async () => '1'
      export const sqlJson = async query => query.includes('pg_tables') ? [] : polls++ === 0 ? [{ id: 23, function_name: 'lineup-optimizer', worker_status: 'pending' }] : []
      export const databaseEnvironment = () => ({})
      export const localKeys = () => ({})
    `
    const fakeDump = `import { writeFileSync } from 'node:fs'; export const execFileSync = (_, args) => writeFileSync(args.at(-1), 'SYNTHETIC unit dump')`
    const program = `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === './local-stack.mjs') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeStack)}`)}, shortCircuit: true }
        if (specifier === 'node:child_process') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeDump)}`)}, shortCircuit: true }
        return next(specifier, context)
      } })
      globalThis.fetch = async () => Response.json({ active: 0, fetches: 0 })
      const { saveSnapshot } = await import(${JSON.stringify(new URL('./checkpoints.mjs', import.meta.url).href)})
      console.log(JSON.stringify(await saveSnapshot('live-week', {})))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: path.join(directory, 'repo'), encoding: 'utf8',
      env: { ...process.env, SEASON_SIM_PROJECT:'pt4bafake',SEASON_SIM_PORT_PREFIX:'574',SEASON_SIM_CONTAINER:'supabase_db_pt4bafake', SEASON_SIM_ROOT: directory, SEASON_SIM_SNAPSHOT_ROOT: path.join(directory, 'snapshots') },
    })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.equal(result.quiescence.polls, 2)
    assert.equal(await readFile(path.join(directory, 'snapshots/live-week/database.dump'), 'utf8'), 'SYNTHETIC unit dump')
    const offline = program.replace(encodeURIComponent(fakeStack), encodeURIComponent(fakeStack.replace("polls++ === 0 ? [{ id: 23, function_name: 'lineup-optimizer', worker_status: 'pending' }] : []", '[]')))
      .replace("globalThis.fetch = async () => Response.json({ active: 0, fetches: 0 })", "globalThis.fetch = async () => { throw Object.assign(new Error('Stopped unit runtime'), { cause: { code: 'ECONNREFUSED' } }) }")
      .replace("saveSnapshot('live-week'", "saveSnapshot('waiver-week'")
    const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', offline], {
      cwd: path.join(directory, 'repo'), encoding: 'utf8',
      env: { ...process.env, SEASON_SIM_PROJECT:'pt4bafake',SEASON_SIM_PORT_PREFIX:'574',SEASON_SIM_CONTAINER:'supabase_db_pt4bafake', SEASON_SIM_ROOT: directory, SEASON_SIM_SNAPSHOT_ROOT: path.join(directory, 'snapshots') },
    })
    assert.equal(stopped.status, 0, stopped.stderr)
    assert.equal(JSON.parse(stopped.stdout).quiescence.polls, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('snapshot writes use the launcher root set after static module imports', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'season-sim-snapshot-')))
  try {
    const root = path.join(directory, 'lane')
    const oldRoot = path.join(directory, 'old')
    const nextRoot = path.join(directory, 'next')
    await mkdir(path.join(root, 'repo'), { recursive: true })
    await mkdir(path.join(oldRoot, 'waiver-week'), { recursive: true })
    await writeFile(path.join(oldRoot, 'waiver-week/sentinel'), 'retained')
    const program = `
      const { saveSnapshot } = await import(${JSON.stringify(new URL('./checkpoints.mjs', import.meta.url).href)})
      process.env.SEASON_SIM_SNAPSHOT_ROOT = ${JSON.stringify(nextRoot)}
      try { await saveSnapshot('waiver-week', {}) }
      catch (error) { console.log(JSON.stringify({ code: error.code, path: error.path })) }
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: path.join(root, 'repo'), encoding: 'utf8',
      env: { ...process.env, SEASON_SIM_PROJECT:'pt4bafake',SEASON_SIM_PORT_PREFIX:'574',SEASON_SIM_CONTAINER:'supabase_db_pt4bafake', SEASON_SIM_ROOT: root, SEASON_SIM_SNAPSHOT_ROOT: oldRoot },
    })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.equal(result.code, 'ENOENT', 'The first read must reach the scratch clock, rather than collide with retained snapshots')
    assert.equal(result.path, path.join(root, 'state/clock.json'))
    assert.ok((await stat(path.join(nextRoot, 'waiver-week'))).isDirectory())
    assert.equal(await readFile(path.join(oldRoot, 'waiver-week/sentinel'), 'utf8'), 'retained')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
