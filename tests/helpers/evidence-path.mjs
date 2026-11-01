import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function evidencePath(name) {
  const root = path.resolve(process.env.PANCAKE_TEST_EVIDENCE_DIR ?? path.join(tmpdir(), 'pancake-test-evidence'))
  const relative = path.relative(repository, root)
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Test evidence must stay outside the repository')
  const file = path.resolve(root, name)
  const child = path.relative(root, file)
  assert.ok(child && child !== '..' && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child), 'Evidence names must stay inside the evidence directory')
  mkdirSync(path.dirname(file), { recursive: true })
  return file
}
