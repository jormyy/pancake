import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function acquireLock(name) {
  const directory = path.join(homedir(), 'pancake-t_4ba51e0d/shared', name)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(directory)
      writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ lane: 'fable-a3', pid: process.pid, started: new Date().toISOString() }))
      return () => rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')) } catch { return null }
      let dead = false
      try { process.kill(owner.pid, 0) } catch (probe) { dead = probe.code === 'ESRCH' }
      const started = Date.parse(owner.started ?? owner.startedAt)
      if (!dead && (!Number.isFinite(started) || Date.now() - started <= 3 * 60 * 60 * 1000)) return null
      rmSync(directory, { recursive: true, force: true })
    }
  }
  return null
}
