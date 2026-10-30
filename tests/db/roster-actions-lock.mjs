import assert from 'node:assert/strict'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function acquire(directory, lane) {
  try {
    await mkdir(directory)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    let owner
    try { owner = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')) } catch {}
    const age = Date.now() - (owner?.started || owner?.startedAt ? Date.parse(owner.started ?? owner.startedAt) : (await stat(directory)).mtimeMs)
    let dead = false
    if (Number.isInteger(owner?.pid)) {
      try { process.kill(owner.pid, 0) } catch (failure) { if (failure.code === 'ESRCH') dead = true }
    }
    if (!dead && age <= 3 * 60 * 60 * 1000) return null
    await rm(directory, { recursive: true })
    return acquire(directory, lane)
  }
  const owner = { lane, pid: process.pid, started: new Date().toISOString() }
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify(owner))
  return async () => {
    const current = JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8'))
    assert.deepEqual(current, owner)
    await rm(directory, { recursive: true })
  }
}
