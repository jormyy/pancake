import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { miniRoot, sha256 } from './common.mjs'

export async function harnessManifest(root = process.cwd()) {
  const files = []
  const visit = async directory => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) files.push(file)
      else throw new Error(`Harness source cannot contain a symlink: ${file}`)
    }
  }
  await visit('scripts/season-sim')
  files.push('docs/season-simulator.md')
  const rows = await Promise.all(files.sort().map(async file => ({ file, sha256: sha256(await readFile(path.join(root, file))) })))
  return { sha256: sha256(JSON.stringify(rows)), files: rows }
}

export async function sourceEvidence() {
  let application = null
  try { application = JSON.parse(await readFile(path.join(miniRoot, 'application-source.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (application) {
    assert.match(application.commit, /^[a-f0-9]{40}$/)
    assert.match(application.archiveSha256, /^[a-f0-9]{64}$/)
  }
  const harness = await harnessManifest()
  return { application, harness, capturedAt: new Date().toISOString(), committedHarness: application?.harnessSha256 === harness.sha256 }
}
