import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { restoreSnapshot, segmentNames, snapshotRoot } from './checkpoints.mjs'
import { replay } from './replay.mjs'

export async function runSegment(name, options = {}) {
  if (!segmentNames.includes(name)) throw new Error(`Unknown segment: ${name}`)
  const started = Date.now()
  const proof = { name, sourceSnapshot: path.join(snapshotRoot(), name), startedAt: new Date().toISOString(), passed: false }
  try {
    const snapshot = await restoreSnapshot(name)
    let interruptions = []
    try { interruptions = (await readFile(path.join(miniRoot, 'evidence/continuation-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.snapshotSha256 === snapshot.dumpSha256) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const result = await replay({ interruptions, ...snapshot.cursor.options, ...(options.days ? { days: Number(options.days) } : {}), resume: snapshot.cursor, segment: name, afterRestoreSql: options['after-restore-sql'], restoredDefinitions: snapshot.restore.definitionsAfter })
    proof.passed = result.complete === true && !result.failure && !result.error && !result.cleanupError
    proof.assertions = result.days
    proof.source = result.source ?? null
    proof.snapshotDumpSha256 = snapshot.dumpSha256
    proof.fixturesSha256 = snapshot.fixtures.manifestSha256
    proof.baseline = !result.overlay
    proof.restore = snapshot.restore
    proof.overlay = result.overlay ?? null
  } catch (error) {
    proof.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    proof.finishedAt = new Date().toISOString()
    proof.seconds = (Date.now() - started) / 1000
    await writeJson(path.join(miniRoot, `evidence/segment-${name}.json`), proof)
  }
}
