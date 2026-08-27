import { appendFile, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from '../tests/e2e/release-provenance.mjs'

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)

const repositoryCommit = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()

const SERVICE_WORKER_VERSION = /const VERSION = '[^']*'/
const SERVICE_WORKER_PRECACHE = /const PRECACHE_URLS = \[[^\]]*\]/

// Everything the shell HTML boots from. Precaching exactly this set means the
// reload that follows a service-worker update paints from disk instead of
// re-downloading the bundle, which is what turned every deploy into a blank
// launch. Deliberately not the whole build: per-route chunks stay lazy.
/** Hashed asset paths under dist/assets, as URLs. */
const assetUrls = async (root) => {
  const walk = async (dir, prefix) => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const next = `${prefix}/${entry.name}`
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), next)))
      else out.push(next)
    }
    return out
  }
  return walk(path.join(root, 'dist', 'assets'), '/assets')
}

// Same-origin absolute paths only. "//host/path" also starts with a slash but
// resolves off-origin, and the worker must never precache something it does not
// serve.
const isSameOriginPath = (url) => url.startsWith('/') && !url.startsWith('//')

const bootAssets = (html, assets) => {
  const urls = new Set(['/'])
  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (isSameOriginPath(src)) urls.add(src)
  }
  for (const [, href] of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    if (isSameOriginPath(href)) urls.add(href)
  }
  // The boot shell paints its brand mark before any bundle runs.
  urls.add('/pwa-192.png')
  urls.add('/manifest.webmanifest')
  // Fonts are fetched by the bundle, not the document, so they only start
  // downloading once the app has mounted: the chrome renders empty icon boxes
  // and fallback type for seconds after the shell hands off. Precache the ones
  // the bundle actually names — they are small next to the bundle itself.
  for (const url of assets.fonts) urls.add(url)
  return [...urls].sort()
}

const FONT_SOURCE_ROOTS = ['app', 'components', 'constants', 'hooks', 'lib']

const sourceText = async (dir) => {
  const parts = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const next = path.join(dir, entry.name)
    if (entry.isDirectory()) parts.push(await sourceText(next))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) parts.push(await readFile(next, 'utf8'))
  }
  return parts.join('\n')
}

/**
 * Fonts under dist/assets that the app itself names. Deliberately not "named
 * anywhere in the bundle": @expo-google-fonts re-exports every weight, so that
 * would precache nine Outfit faces to render three.
 */
const referencedFonts = async (root, assets) => {
  const fonts = assets.filter((url) => /\.(?:ttf|otf|woff2?)$/.test(url))
  if (fonts.length === 0) return []
  const sources = await Promise.all(FONT_SOURCE_ROOTS.map((dir) => sourceText(path.join(root, dir))))
  const appSource = sources.join('\n')
  return fonts.filter((url) => {
    const family = (url.split('/').pop() ?? '').split('.')[0]
    return family.length > 0 && appSource.includes(family)
  })
}

const setServiceWorkerPrecache = async (root) => {
  const workerPath = path.join(root, 'dist', 'sw.js')
  let source
  try {
    source = await readFile(workerPath, 'utf8')
  } catch {
    return
  }
  if (!SERVICE_WORKER_PRECACHE.test(source)) {
    throw new Error('Service worker is missing its PRECACHE_URLS declaration; deploys would launch with a cold bundle')
  }
  const html = await readFile(path.join(root, 'dist', 'index.html'), 'utf8')
  const assets = await assetUrls(root)
  const urls = bootAssets(html, { fonts: await referencedFonts(root, assets) })
  if (urls.length < 3) {
    throw new Error('Release build produced no boot assets to precache; the shell HTML is probably malformed')
  }
  await writeFile(
    workerPath,
    source.replace(SERVICE_WORKER_PRECACHE, `const PRECACHE_URLS = ${JSON.stringify(urls)}`),
  )
}

// Normalize before hashing. This makes repeated stamps deterministic.
const setServiceWorkerVersion = async (root, version) => {
  const workerPath = path.join(root, 'dist', 'sw.js')
  let source
  try {
    source = await readFile(workerPath, 'utf8')
  } catch {
    return
  }
  if (!SERVICE_WORKER_VERSION.test(source)) {
    throw new Error('Service worker is missing its VERSION declaration; cache versioning would silently stop working')
  }
  await writeFile(
    workerPath,
    source.replace(SERVICE_WORKER_VERSION, `const VERSION = '${version}'`),
  )
}

export const stampReleaseProvenance = async ({
  root = process.cwd(),
  commitSha = process.env.E2E_EXPECTED_RELEASE_SHA || process.env.PANCAKE_RELEASE_SHA ||
    process.env.E2E_RELEASE_SHA || process.env.GITHUB_SHA || repositoryCommit(root),
} = {}) => {
  if (!fullSha(commitSha)) throw new Error('Release marker requires a full commit SHA')
  // Before the digest, so the precached set is covered by the cache version.
  await setServiceWorkerPrecache(root)
  await setServiceWorkerVersion(root, 'pancake-build')
  const cacheDigest = await digestReleaseBundle(root)
  await setServiceWorkerVersion(
    root,
    `pancake-${commitSha.slice(0, 12)}-${cacheDigest.slice(0, 12)}`,
  )
  const marker = {
    commitSha: commitSha.toLowerCase(),
    bundleDigest: await digestReleaseBundle(root),
    deploymentInputs: FRONTEND_DEPLOYMENT_INPUTS,
  }
  await writeFile(path.join(root, 'dist', 'release-provenance.json'), `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const marker = await stampReleaseProvenance()
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `bundle_digest=${marker.bundleDigest}\n`)
  }
  console.log(JSON.stringify(marker))
}
