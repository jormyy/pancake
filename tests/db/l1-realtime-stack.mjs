import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { command } from '../../scripts/perf-lab/process.mjs'

export async function restoreLock({ directory = `${homedir()}/pancake-t_4ba51e0d/shared/restore.lock`, pause = milliseconds => delay(milliseconds), alive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
} } = {}) {
  const owner = { pid: process.pid, lane: 'fable-l1', token: randomUUID(), startedAt: new Date().toISOString() }
  for (;;) {
    try {
      await mkdir(directory)
      await writeFile(`${directory}/owner.json`, JSON.stringify(owner), { mode: 0o600 })
      return async () => {
        const current = await readFile(`${directory}/owner.json`, 'utf8').then(JSON.parse, () => null)
        assert.equal(current?.token, owner.token, 'Only the restore lock owner may release it')
        await rm(directory, { recursive: true })
      }
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    const current = await readFile(`${directory}/owner.json`, 'utf8').then(JSON.parse, () => null)
    const timestamp = Date.parse(current?.startedAt)
    const created = Number.isFinite(timestamp) ? timestamp : await stat(directory).then(value => value.mtimeMs, () => Date.now())
    const stale = current ? !alive(current.pid) || Date.now() - created > 45 * 60000 : Date.now() - created > 10000
    if (stale) await rm(directory, { recursive: true, force: true })
    else await pause(5000)
  }
}

export async function stackCommand(file, args, options = {}, { run = command, pause = milliseconds => delay(milliseconds), record = async () => {} } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await run(file, args, { ...options, allowFailure: true })
    if (result.code === 0) return result
    if (/\bEOF\b/i.test(result.stdout + result.stderr) && attempt < 5) {
      const delayMs = 2000 * attempt
      await record({ file, args, attempt, delayMs, at: new Date().toISOString(), reason: 'Docker socket EOF' })
      await pause(delayMs)
      continue
    }
    throw new Error(`${file} ${args[0]} failed (${result.code}); inspect the private stack log`)
  }
}
