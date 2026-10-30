import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { buildWeb, certificate } from '../../scripts/perf-lab/build.mjs'
import { localKeys } from '../../scripts/perf-lab/database.mjs'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { beginConcurrentRun } from './l1-realtime-concurrency.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
const baselineCommit = '952580ce3204598d1fd120b3f121d166c7626028'
const progress = value => writeFile(`${labRoot}/build-progress.json`, JSON.stringify({ pid: process.pid, ...value, at: new Date().toISOString() }))
await progress({ status: 'preparing-concurrent' })
const release = await beginConcurrentRun()
const source = await readFile('lib/realtime.ts')
try {
  await writeFile(`${labRoot}/runtime-stop`, '')
  await writeFile(`${labRoot}/legacy-stop`, '')
  let stopped = false
  for (let attempt = 0; attempt < 60; attempt++) {
    stopped = !await fetch('http://127.0.0.1:62281/health', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
    if (stopped) break
    await delay(500)
  }
  assert.ok(stopped, 'The previous owned Edge runtime must stop before rebuilding')
  await rm(`${labRoot}/runtime-ready.json`, { force: true })
  await rm(`${labRoot}/active-frontend-ready`, { force: true })
  const keys = await localKeys()
  const tls = await certificate()
  const baseline = (await command('git', ['show', `${baselineCommit}:lib/realtime.ts`])).stdout
  await writeFile('lib/realtime.ts', baseline)
  await progress({ status: 'building-postgres' })
  await buildWeb(keys, tls)
  await rm(`${labRoot}/web-baseline`, { recursive: true, force: true })
  await cp(`${labRoot}/web-export`, `${labRoot}/web-baseline`, { recursive: true })
  await writeFile(`${labRoot}/web-baseline/l1-release.json`, JSON.stringify({ commit: baselineCommit, version: '2.11.1', sharedCacheFix: true }))
  await writeFile('lib/realtime.ts', source)
  await progress({ status: 'building-broadcast' })
  const candidate = await buildWeb(keys, tls)
  const log = await open(`${labRoot}/browser-serve.log`, 'a', 0o600)
  const child = spawn(process.execPath, ['../browser-serve.mjs'], { detached: true, stdio: ['ignore', log.fd, log.fd] })
  child.unref()
  await log.close()
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await readFile(`${labRoot}/runtime-ready.json`, 'utf8').then(JSON.parse, () => null)
    if (value?.active === 'broadcast') { ready = true; break }
    assert.equal(child.exitCode, null, 'The fresh owned browser runtime must stay alive')
    await delay(500)
  }
  assert.ok(ready, 'The fresh browser runtime must become ready')
  await writeFile(`${labRoot}/evidence/build-2111.json`, JSON.stringify({ baselineCommit, candidateCommit: candidate.commitSha, sharedCacheFix: true, runtimePid: child.pid }))
  await progress({ status: 'built', baselineCommit, candidateCommit: candidate.commitSha, runtimePid: child.pid })
} catch (error) {
  await progress({ status: 'failed', error: String(error.message).replace(/eyJ[\w.-]+/g, '[redacted]').slice(0, 1200) })
  throw error
} finally { await writeFile('lib/realtime.ts', source); await release() }
