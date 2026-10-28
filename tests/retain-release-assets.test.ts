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
  vi.unstubAllGlobals()
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

const loaderPath = '_expo/static/js/web/timeline-80299833db34e21f0ac67fea46a72b25.js'
const screenPath = (label: string) => `_expo/static/js/web/TimelineScreen-${label.repeat(32)}.js`
const loader = (label: string) => `__d(function(g,r,i,a,m,e,d){"use strict";e.loadTimeline=function(){return r(d[2])(d[1],d.paths)}},815,{"0":12,"1":817,"2":10,"paths":{"817":"/${screenPath(label)}"}});`

async function exportLoaderRelease(label: string, source = loader(label)) {
  const root = await exportRelease(label)
  await writeFile(path.join(root, 'dist', loaderPath), source)
  await writeFile(path.join(root, 'dist', screenPath(label)), `globalThis.screen = '${label}'`)
  for (const name of ['index.html', 'sign-in.html']) {
    await writeFile(path.join(root, 'dist', name), `<link rel="manifest" href="/manifest.webmanifest"><script src="/${loaderPath}"></script>`)
  }
  return root
}

it('accepts identical same-path loader bytes', async () => {
  const first = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportLoaderRelease('a')
  const receipt = await retainReleaseAssets(second, path.join(first, 'dist'))
  expect(receipt.files.map((file: { path: string }) => file.path)).not.toContain(loaderPath)
  expect(await readFile(path.join(second, 'dist', loaderPath), 'utf8')).toBe(loader('a'))
})

it('ships the new same-path loader and retains its old referenced assets', async () => {
  const first = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportLoaderRelease('b')
  const options = { root: second, commitSha: 'b'.repeat(40), previousRelease: path.join(first, 'dist') }
  const marker = await stampReleaseProvenance(options)
  expect(await readFile(path.join(second, 'dist', loaderPath), 'utf8')).toBe(loader('b'))
  expect(await readFile(path.join(second, 'dist', screenPath('a')), 'utf8')).toBe("globalThis.screen = 'a'")
  const receipt = JSON.parse(await readFile(path.join(second, 'dist/release-compatibility.json'), 'utf8'))
  expect(receipt.files.map((file: { path: string }) => file.path)).toContain(screenPath('a'))
  expect(receipt.files.map((file: { path: string }) => file.path)).not.toContain(loaderPath)
  const release = await readPwaRelease(path.join(second, 'dist'))
  const currentLoader = marker.artifact.files.find((file: { path: string }) => file.path === loaderPath)!
  expect(release.bootHashes[`/${loaderPath}`]).toBe(currentLoader.sha256)
  expect(release.bootHashes).not.toHaveProperty(`/${screenPath('a')}`)
  expect((await stampReleaseProvenance(options)).bundleDigest).toBe(marker.bundleDigest)
})

it('rejects a same-path loader with changes outside its referenced paths', async () => {
  const first = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportLoaderRelease('b', loader('b').replace('r(d[2])', 'r(d[0])'))
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/same path/)
})

it('rejects a same-path loader when an old referenced asset would be dropped', async () => {
  const ancestor = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: ancestor, commitSha: 'a'.repeat(40) })
  const first = await exportRelease('b')
  await stampReleaseProvenance({ root: first, commitSha: 'b'.repeat(40), previousRelease: path.join(ancestor, 'dist') })
  await writeFile(path.join(first, 'dist', loaderPath), loader('a'))
  const receiptPath = path.join(first, 'dist/release-compatibility.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  receipt.files = receipt.files.filter((file: { path: string }) => file.path !== loaderPath)
  await writeFile(receiptPath, JSON.stringify(receipt))
  await stampReleaseProvenance({ root: first, commitSha: 'b'.repeat(40) })
  const second = await exportLoaderRelease('c')
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/old referenced asset is not retained/)
  await expect(readFile(path.join(second, 'dist', screenPath('a')))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['module identifier', (source: string) => source.replace('},815,', '},816,')],
  ['dependency key', (source: string) => source.replace('"817":"/', '"818":"/')],
  ['text outside the paths map', (source: string) => source.replace('"use strict";', `"use strict";e.label="/${screenPath('b')}";`)],
  ['unsafe asset path', (source: string) => source.replace('/_expo/static/js/web/', '/_expo/static/js/web/../web/')],
] as const)('rejects same-path changes to %s', async (_label, change) => {
  const first = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportLoaderRelease('b', change(loader('b')))
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/same path/)
})

it('rejects a same-path loader when its new referenced asset is missing', async () => {
  const first = await exportLoaderRelease('a')
  await stampReleaseProvenance({ root: first, commitSha: 'a'.repeat(40) })
  const second = await exportLoaderRelease('b')
  await rm(path.join(second, 'dist', screenPath('b')))
  await expect(retainReleaseAssets(second, path.join(first, 'dist'))).rejects.toThrow(/new referenced asset is missing/)
})

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


it.each(['', 'development', 'preview'])('never fetches a pinned remote predecessor during %s local builds', async environment => {
  const root = await exportRelease('local')
  await writeFile(path.join(root, 'release-predecessor.json'), JSON.stringify({ url: 'https://predecessor.example.test', commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }))
  vi.stubEnv('VERCEL_ENV', environment)
  vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', '0')
  const fetch = vi.fn(async () => { throw new Error('Unexpected network request') })
  vi.stubGlobal('fetch', fetch)
  await expect(prepareReleaseCompatibility(root, undefined)).resolves.toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['production', 'opt-in'])('permits remote recovery only for %s', async mode => {
  const root = await exportRelease('allowed')
  await writeFile(path.join(root, 'release-predecessor.json'), JSON.stringify({ url: 'https://predecessor.example.test', commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }))
  vi.stubEnv('VERCEL_ENV', mode === 'production' ? 'production' : 'preview')
  vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', mode === 'opt-in' ? '1' : '0')
  const fetch = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  await expect(prepareReleaseCompatibility(root, undefined)).rejects.toThrow()
  expect(fetch).toHaveBeenCalled()
})

it('uses a verified local predecessor without network access', async () => {
  const previous = await exportRelease('previous')
  await stampReleaseProvenance({ root: previous, commitSha: 'a'.repeat(40) })
  const root = await exportRelease('current')
  vi.stubEnv('VERCEL_ENV', 'preview')
  vi.stubEnv('PANCAKE_PREVIOUS_RELEASE_ROOT', path.join(previous, 'dist'))
  const fetch = vi.fn(async () => { throw new Error('Unexpected network request') })
  vi.stubGlobal('fetch', fetch)
  expect(await prepareReleaseCompatibility(root, undefined)).toMatchObject({ commitSha: 'a'.repeat(40) })
  expect(fetch).not.toHaveBeenCalled()
})
