import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendFileSync, createBoundedAppender } from '../../scripts/perf-lab/bounded-log.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'perf-log-smoke-'))
try {
  const file = path.join(directory, 'capture.jsonl')
  const append = createBoundedAppender(8)
  append(file, '12345678')
  assert.throws(() => append(file, '9'), /Capture file limit exceeded/)
  assert.equal(await readFile(file, 'utf8'), '12345678')
  const wrapper = path.join(directory, 'wrapper.jsonl')
  appendFileSync(wrapper, 'recorded')
  assert.equal(await readFile(wrapper, 'utf8'), 'recorded')
  console.log('Deno preserves the capture byte limit')
} finally { await rm(directory, { recursive: true, force: true }) }
