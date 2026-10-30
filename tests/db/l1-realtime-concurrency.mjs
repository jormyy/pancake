import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'

export async function beginConcurrentRun() {
  await requireMini()
  assert.equal(project, 'pt4bafablel1')
  const file = `${labRoot}/evidence/concurrent-${process.pid}.json`
  const value = { pid: process.pid, concurrentLanes: true, measurementLock: false, startedAt: new Date().toISOString() }
  await writeFile(file, JSON.stringify(value), { mode: 0o600 })
  return () => writeFile(file, JSON.stringify({ ...value, finishedAt: new Date().toISOString() }), { mode: 0o600 })
}
