import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

export async function acquireMeasurementLock(directory, lane, wait = async ms => { await pause(ms) }, report = console.log) {
  for (;;) {
    try { await mkdir(directory); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      report(JSON.stringify({ event: 'measurement-lock-wait', lane }))
      await wait(60000)
    }
  }
  const owner = { lane, startedAt: new Date().toISOString(), pid: process.pid, token: randomUUID() }
  const file = path.join(directory, 'owner.json')
  try { await writeFile(file, JSON.stringify(owner)) } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    let current
    try { current = JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (current.token !== owner.token) throw new Error('Measurement lock ownership changed')
    await rm(directory, { recursive: true })
  }
}

export async function withMeasurementLock(directory, lane, action, wait, report) {
  const release = await acquireMeasurementLock(directory, lane, wait, report)
  try { return await action() } finally { await release() }
}

export async function withMeasuredStack(directory, lane, stack, action, wait, report, batchParent) {
  await stack.stop()
  if (batchParent !== undefined) {
    const owner = JSON.parse(await readFile(path.join(directory,'owner.json'),'utf8'))
    if (owner.lane !== lane || owner.pid !== batchParent || batchParent !== process.ppid) throw new Error('L4 batch lock must belong to the direct parent')
    try { await stack.start(); return await action() } finally { await stack.stop() }
  }
  return withMeasurementLock(directory, lane, async () => {
    try { await stack.start(); return await action() } finally { await stack.stop() }
  }, wait, report)
}
