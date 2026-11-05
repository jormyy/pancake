import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stampReleaseProvenance } from '../scripts/stamp-release-provenance.mjs'
import { prepareReleaseCompatibility, retainReleaseAssets } from '../scripts/retain-release-assets.mjs'
import { FRONTEND_DEPLOYMENT_INPUTS } from './e2e/release-provenance.mjs'
import { readPwaRelease } from './e2e/pwa-update-release.mjs'

const roots: string[] = []
beforeEach(() => {
  vi.stubEnv('VERCEL_ENV', '')
  vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', '')
  vi.stubEnv('PANCAKE_PREVIOUS_RELEASE_ROOT', '')
  vi.stubEnv('PANCAKE_PREDECESSOR_URL', '')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request') }))
})
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

it.each(['production', 'opt-in'])('discovers and verifies the live predecessor for %s', async mode => {
  const previous = await exportRelease('previous')
  const marker = await stampReleaseProvenance({ root: previous, commitSha: 'a'.repeat(40) })
  const root = await exportRelease('current')
  vi.stubEnv('VERCEL_ENV', mode === 'production' ? 'production' : 'preview')
  vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', mode === 'opt-in' ? '1' : '0')
  if (mode === 'opt-in') vi.stubEnv('PANCAKE_PREDECESSOR_URL', 'http://127.0.0.1:9999/release')
  const base = mode === 'production' ? 'https://pancakedynasty.vercel.app' : 'http://127.0.0.1:9999/release'
  const fetch = vi.fn(async (url: URL) => {
    expect(url.href.startsWith(`${base}/`)).toBe(true)
    const name = decodeURIComponent(url.href.slice(base.length + 1))
    return new Response(await readFile(path.join(previous, 'dist', name)))
  })
  vi.stubGlobal('fetch', fetch)
  expect(await prepareReleaseCompatibility(root, undefined)).toMatchObject({
    commitSha: marker.commitSha, bundleDigest: marker.bundleDigest,
  })
  expect(await readFile(path.join(root, 'dist/_expo/static/js/web/previous.js'), 'utf8')).toBe("globalThis.loaded = 'previous'")
  const markerCalls = fetch.mock.calls.filter(([url]) => url.pathname.endsWith('/release-provenance.json'))
  expect(markerCalls).toHaveLength(3)
  expect(fetch).toHaveBeenCalledWith(new URL(`${base}/release-provenance.json`), {
    redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: expect.any(AbortSignal),
  })
})

it.each(['unreachable', 'missing', 'invalid JSON', 'redirected', 'null', 'missing identity', 'short SHA', 'non-hex SHA', 'numeric SHA', 'short digest', 'non-hex digest'])(
  'fails production when the live marker is %s', async failure => {
    const root = await exportRelease('current')
    vi.stubEnv('VERCEL_ENV', 'production')
    const marker = { commitSha: 'a'.repeat(40), bundleDigest: 'b'.repeat(64) }
    const fetch = vi.fn(async () => {
      if (failure === 'unreachable') throw new Error('Network unavailable')
      if (failure === 'missing') return new Response('Missing', { status: 404 })
      if (failure === 'invalid JSON') return new Response('{')
      if (failure === 'null') return new Response('null')
      if (failure === 'missing identity') return new Response('{}')
      if (failure === 'short SHA') marker.commitSha = 'a'.repeat(39)
      if (failure === 'non-hex SHA') marker.commitSha = 'g'.repeat(40)
      if (failure === 'short digest') marker.bundleDigest = 'b'.repeat(63)
      if (failure === 'non-hex digest') marker.bundleDigest = 'g'.repeat(64)
      const response = new Response(JSON.stringify(failure === 'numeric SHA' ? { ...marker, commitSha: 1e39 } : marker))
      if (failure === 'redirected') Object.defineProperty(response, 'redirected', { value: true })
      return response
    })
    vi.stubGlobal('fetch', fetch)
    await expect(prepareReleaseCompatibility(root, undefined)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(readFile(path.join(root, 'dist/release-compatibility.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['http://example.test', 'https://user:password@example.test', 'https://example.test?query=1', 'https://example.test#hash'])(
  'rejects an unsafe predecessor URL %s before fetching', async url => {
    const root = await exportRelease('current')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PANCAKE_PREDECESSOR_URL', url)
    await expect(prepareReleaseCompatibility(root, undefined)).rejects.toThrow(/HTTPS or an isolated loopback/)
    expect(fetch).not.toHaveBeenCalled()
  },
)

it.each(['changed identity', 'corrupt bytes', 'wrong digest'])(
  'fails production recovery for %s', async failure => {
    const previous = await exportRelease('previous')
    const marker = await stampReleaseProvenance({ root: previous, commitSha: 'a'.repeat(40) })
    const root = await exportRelease('current')
    vi.stubEnv('VERCEL_ENV', 'production')
    let markers = 0
    const fetch = vi.fn(async (url: URL) => {
      const name = decodeURIComponent(url.pathname.slice(1))
      if (name === 'release-provenance.json') {
        markers += 1
        return new Response(JSON.stringify({ ...marker,
          commitSha: failure === 'changed identity' && markers > 1 ? 'b'.repeat(40) : marker.commitSha,
          bundleDigest: failure === 'wrong digest' ? 'b'.repeat(64) : marker.bundleDigest,
        }))
      }
      return new Response(failure === 'corrupt bytes' ? 'corrupted' : await readFile(path.join(previous, 'dist', name)))
    })
    vi.stubGlobal('fetch', fetch)
    const error = failure === 'changed identity' ? /expected source and digest/
      : failure === 'corrupt bytes' ? /bytes do not match/ : /digest does not match production/
    await expect(prepareReleaseCompatibility(root, undefined)).rejects.toThrow(error)
    await expect(readFile(path.join(root, 'dist/release-compatibility.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['', 'development', 'preview'])('never fetches during %s local builds', async environment => {
  const root = await exportRelease('local')
  vi.stubEnv('VERCEL_ENV', environment)
  vi.stubEnv('PANCAKE_PREDECESSOR_URL', 'https://predecessor.example.test')
  await expect(prepareReleaseCompatibility(root, undefined)).resolves.toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['environment', 'argument'])('prefers a verified local predecessor from the %s during production', async source => {
  const previous = await exportRelease('previous')
  const marker = await stampReleaseProvenance({ root: previous, commitSha: 'a'.repeat(40) })
  const root = await exportRelease('current')
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('PANCAKE_FETCH_PREDECESSOR', '1')
  vi.stubEnv('PANCAKE_PREVIOUS_RELEASE_ROOT', source === 'environment' ? path.join(previous, 'dist') : '/unused')
  expect(await prepareReleaseCompatibility(root, source === 'argument' ? path.join(previous, 'dist') : undefined)).toMatchObject({
    commitSha: marker.commitSha, bundleDigest: marker.bundleDigest,
  })
  expect(fetch).not.toHaveBeenCalled()
})
