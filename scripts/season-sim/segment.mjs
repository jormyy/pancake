import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { miniRoot, writeJson } from './common.mjs'
import { restoreSnapshot, segmentNames, snapshotRoot } from './checkpoints.mjs'
import { replay } from './replay.mjs'

export async function runSegment(name) {
  if (!segmentNames.includes(name)) throw new Error(`Unknown segment: ${name}`)
  const started = Date.now()
  const proof = { name, sourceSnapshot: path.join(snapshotRoot, name), startedAt: new Date().toISOString(), passed: false }
  try {
    const snapshot = await restoreSnapshot(name)
    await replay({ ...snapshot.cursor.options, resume: snapshot.cursor, segment: name })
    const result = JSON.parse(await readFile(path.join(miniRoot, 'evidence/replay-checkpoint.json'), 'utf8'))
    proof.passed = result.complete === true && !result.failure
    proof.assertions = result.days
  } catch (error) {
    proof.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    proof.finishedAt = new Date().toISOString()
    proof.seconds = (Date.now() - started) / 1000
    await writeJson(path.join(miniRoot, `evidence/segment-${name}.json`), proof)
  }
}
