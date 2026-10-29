import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

export async function archiveEvidence(directory) {
  const previous = JSON.parse(await readFile(path.join(directory, 'database-run.json'), 'utf8').catch(() => 'null'))
  if (!previous?.runId) return
  assert.match(previous.runId, /^[a-f0-9-]{36}$/)
  const archive = path.join(directory, 'history', previous.runId)
  const entries = (await readdir(directory)).filter(entry => entry !== 'history')
  if (!await stat(archive).catch(() => null)) {
    await mkdir(archive, { recursive: true })
    for (const entry of entries) await cp(path.join(directory, entry), path.join(archive, entry), { recursive: true, mode: constants.COPYFILE_FICLONE })
  }
  for (const entry of entries.filter(entry => !['coverage.json', 'preflight.json', 'https.json'].includes(entry))) await rm(path.join(directory, entry), { recursive: true, force: true })
}
