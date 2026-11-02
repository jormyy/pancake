import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { evidencePath } from './helpers/evidence-path.mjs'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('writes under the selected external directory', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'evidence-path-'))
  directories.push(directory)
  vi.stubEnv('PANCAKE_TEST_EVIDENCE_DIR', directory)
  expect(evidencePath('checks/result.json')).toBe(path.join(directory, 'checks/result.json'))
})

it('rejects repository output and names that escape the selected directory', () => {
  vi.stubEnv('PANCAKE_TEST_EVIDENCE_DIR', path.resolve('tests/evidence'))
  expect(() => evidencePath('result.json')).toThrow('outside the repository')
  vi.stubEnv('PANCAKE_TEST_EVIDENCE_DIR', tmpdir())
  expect(() => evidencePath('../result.json')).toThrow('inside the evidence directory')
  expect(() => evidencePath('.')).toThrow('inside the evidence directory')
})
