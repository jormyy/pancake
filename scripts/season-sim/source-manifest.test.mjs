import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { harnessManifest } from './source-manifest.mjs'

test('source evidence changes when a harness input changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'season-source-'))
  try {
    await mkdir(path.join(root, 'scripts/season-sim'), { recursive: true })
    await mkdir(path.join(root, 'docs'))
    await writeFile(path.join(root, 'scripts/season-sim/a.mjs'), 'baseline')
    await writeFile(path.join(root, 'docs/season-simulator.md'), 'description')
    const before = await harnessManifest(root)
    await writeFile(path.join(root, 'scripts/season-sim/a.mjs'), 'changed')
    const after = await harnessManifest(root)
    assert.equal(before.files.length, 2)
    assert.notEqual(before.sha256, after.sha256)
  } finally { await rm(root, { recursive: true }) }
})
