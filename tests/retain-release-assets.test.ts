import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { stampReleaseProvenance } from '../scripts/stamp-release-provenance.mjs'
import { prepareReleaseCompatibility, retainReleaseAssets } from '../scripts/retain-release-assets.mjs'
import { FRONTEND_DEPLOYMENT_INPUTS } from './e2e/release-provenance.mjs'
import { readPwaRelease } from './e2e/pwa-update-release.mjs'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function exportRelease(label: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pancake-retention-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist/_expo/static/js/web'), { recursive: true })
  await mkdir(path.join(root, 'dist/assets/fonts'), { recursive: true })
  await mkdir(path.join(root, 'app'))
  await writeFile(path.join(root, 'app/font.ts'), 'export const font = "Outfit_400Regular"')
  await writeFile(path.join(root, `dist/assets/fonts/Outfit_400Regular.${label}.ttf`), `font-${label}`)
  for (const input of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(root, input), '{}')
  const html = '<meta name="pancake-release" content="pancake-build"><link rel="manifest" href="/manifest.webmanifest"><script src="/_expo/static/js/web/entry-same.js"></script>'
  for (const name of ['index.html', 'sign-in.html']) await writeFile(path.join(root, 'dist', name), html)
  await writeFile(path.join(root, 'dist/manifest.webmanifest'), '{}')
  await writeFile(path.join(root, 'dist/_expo/static/js/web/entry-same.js'), `globalThis.route = '${label}.js'`)
  await writeFile(path.join(root, `dist/_expo/static/js/web/${label}.js`), `globalThis.loaded = '${label}'`)
  await writeFile(path.join(root, 'dist/sw.js'), await readFile('public/sw.js'))
  return root
}

it('retains the prior route graph without precaching it and remains repeatable across releases', async () => {
  const first = await exportRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportRelease('b')
  const options = { root: second, commitSha: 'b'.repeat(40), previousRelease: path.join(first, 'dist') }
  const marker = await stampReleaseProvenance(options)
  expect(await readFile(path.join(second, 'dist/_expo/static/js/web/a.js'), 'utf8')).toBe("globalThis.loaded = 'a'")
  expect(await readFile(path.join(second, 'dist/_expo/static/js/web/entry-same.js'), 'utf8')).toBe("globalThis.route = 'b.js'")
  const release = await readPwaRelease(path.join(second, 'dist'))
  expect(release.commitSha).toBe('b'.repeat(40))
  expect(Object.keys(release.bootHashes)).not.toContain('/_expo/static/js/web/a.js')
  expect(Object.keys(release.bootHashes)).not.toContain('/assets/fonts/Outfit_400Regular.a.ttf')
  expect(Object.keys(release.bootHashes)).toContain('/assets/fonts/Outfit_400Regular.b.ttf')
  expect((await stampReleaseProvenance(options)).bundleDigest).toBe(marker.bundleDigest)
  const third = await exportRelease('c')
  await stampReleaseProvenance({ root: third, commitSha: 'c'.repeat(40), previousRelease: path.join(second, 'dist') })
  expect(await readFile(path.join(third, 'dist/_expo/static/js/web/b.js'), 'utf8')).toBe("globalThis.loaded = 'b'")
  await expect(readFile(path.join(third, 'dist/_expo/static/js/web/a.js'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects corrupt prior bytes and conflicting immutable paths', async () => {
  const first = await exportRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportRelease('b')
  await writeFile(path.join(second, 'dist/_expo/static/js/web/a.js'), 'different bytes')
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/same path/)
  await rm(path.join(second, 'dist/_expo/static/js/web/a.js'))
  await writeFile(path.join(first, 'dist/_expo/static/js/web/a.js'), 'corrupted')
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/bytes differ/)
})

it('requires an explicit verified predecessor for production builds', async () => {
  const root = await exportRelease('a')
  vi.stubEnv('VERCEL_ENV', 'production')
  await expect(prepareReleaseCompatibility(root, undefined)).rejects.toThrow(/pinned release-predecessor/)
})
