import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from './e2e/release-provenance.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['altered', 'missing', 'unexpected'])('rejects an %s artifact despite an unchanged source marker', async (change) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-artifact-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist'))
  for (const input of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(root, input), '{}\n')
  await writeFile(path.join(root, 'dist/index.html'), '<script src="/app.js"></script>')
  const script = path.join(root, 'dist/app.js')
  await writeFile(script, 'globalThis.fixture = 1\n')
  const digest = await digestReleaseBundle(root)
  const marker = JSON.stringify({ commitSha: 'a'.repeat(40), bundleDigest: digest })
  await writeFile(path.join(root, 'dist/release-provenance.json'), marker)
  expect(await digestReleaseBundle(root)).toBe(digest)

  if (change === 'altered') await writeFile(script, 'globalThis.fixture = 2\n')
  if (change === 'missing') await rm(script)
  if (change === 'unexpected') await writeFile(path.join(root, 'dist/extra.js'), '// stale output\n')

  expect(await readFile(path.join(root, 'dist/release-provenance.json'), 'utf8')).toBe(marker)
  expect(await digestReleaseBundle(root)).not.toBe(digest)
})
