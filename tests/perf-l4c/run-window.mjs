import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config, miniRoot } from '../../scripts/season-sim/common.mjs'

assert.equal(config.project, 'pt4bafableig')
assert.equal(config.prefix, '630')
assert.equal(process.cwd(), path.join(miniRoot, 'repo'))
process.env.SEASON_SIM_AUTH_CLOCK = '1'
const lock = path.resolve(miniRoot, '../../shared/measure.lock')
let owned = false
const run = async (command, args) => {
  const child = spawn(command, args, { stdio: 'inherit' })
  const forward = signal => child.kill(signal)
  process.once('SIGTERM', forward)
  process.once('SIGINT', forward)
  try {
    const [code, signal] = await once(child, 'exit')
    assert.equal(code, 0, `${command} failed: ${code ?? signal}`)
  } finally {
    process.removeListener('SIGTERM', forward)
    process.removeListener('SIGINT', forward)
  }
}
const stop = async () => {
  for (let attempt = 0; ; attempt++) {
    try { await run('supabase', ['stop', '--project-id', config.project]); return }
    catch (error) {
      if (attempt === 2) throw error
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}
try {
  while (!owned) {
    try { await mkdir(lock); owned = true }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      console.log('Waiting 60 seconds for the shared measurement lock')
      await new Promise(resolve => setTimeout(resolve, 60000))
    }
  }
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ lane: 'fable-l4c', startedAt: new Date().toISOString(), pid: process.pid })}\n`)
  await stop()
  await run(process.execPath, ['--input-type=module', '-e', 'import{setupStack}from"./scripts/season-sim/local-stack.mjs";await setupStack()'])
  await run('docker', ['update', '--cpus', '1', '--memory', '2g', '--memory-swap', '2g', config.container])
  await run(process.execPath, ['--input-type=module', '-e', `import{readFile}from"node:fs/promises";import{sql}from"./scripts/season-sim/local-stack.mjs";if(await sql("SELECT to_regprocedure('pg_catalog.season_sim_native_now()') IS NOT NULL")==="t"){const s=await readFile("scripts/season-sim/restore-clock.sql","utf8");await sql(s.slice(s.indexOf("BEGIN;")))}`])
  const existing = await stat(path.join(miniRoot, 'paired-state/initial.dump')).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  await run(process.execPath, ['tests/perf-l4c/state.mjs', existing ? 'restore' : 'save'])
  const cleaned = await stat(path.join(miniRoot, 'paired-state/queue-reset.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!cleaned) {
    await run(process.execPath, ['tests/perf-l4c/state.mjs', 'clean-queue'])
    await run(process.execPath, ['tests/perf-l4c/state.mjs', 'save'])
  }
  const retired = await stat(path.join(miniRoot, 'paired-state/retired-harness-leagues.json')).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!retired) {
    await run(process.execPath, ['tests/perf-l4c/state.mjs', 'retire-harness-leagues'])
    await run(process.execPath, ['tests/perf-l4c/state.mjs', 'save'])
  }
  const fixtures = JSON.parse(await readFile(path.join(miniRoot, 'window-fixtures/games.json'), 'utf8'))
  if (fixtures.games.some(game => !game.espnId)) await run(process.execPath, ['tests/perf-l4c/prepare-window.mjs'])
  for (const label of ['reference', 'candidate']) {
    if (label === 'candidate') await run(process.execPath, ['tests/perf-l4c/state.mjs', 'restore'])
    await run(process.execPath, [process.env.L4C_CORPUS_ONLY === '1' ? 'tests/perf-l4c/corpus.mjs' : 'tests/perf-l4c/measure.mjs', label])
    await run(process.execPath, ['tests/perf-l4c/state.mjs', 'capture', label])
  }
  await run(process.execPath, ['tests/perf-l4c/state.mjs', 'compare'])
} catch (error) {
  for (const service of ['db', 'auth', 'rest', 'kong', 'realtime', 'storage']) {
    try {
      await run('docker', ['inspect', '--format', '{{.Name}} {{json .State}}', `supabase_${service}_${config.project}`])
    } catch {}
  }
  throw error
} finally {
  if (owned) {
    try { await stop() }
    finally { await rm(lock, { recursive: true }) }
  }
}
