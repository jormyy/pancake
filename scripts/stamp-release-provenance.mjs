import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from '../tests/e2e/release-provenance.mjs'
import { createReleaseArtifactManifest } from '../tests/e2e/release-artifact.mjs'
import { prepareReleaseCompatibility } from './retain-release-assets.mjs'
import { compactDocumentAssets } from './compact-document-assets.mjs'

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)

const repositoryCommit = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()

const SERVICE_WORKER_VERSION = /const VERSION = '[^']*'/
const SERVICE_WORKER_PRECACHE = /const PRECACHE_URLS = \[[^\]]*\]/
const SERVICE_WORKER_PUBLIC_ASSETS = /const PUBLIC_ASSET_URLS = \[[^\n]*\]/
const SERVICE_WORKER_PUBLIC_HASHES = /const PUBLIC_ASSET_HASHES = \{[^\n]*\}/
const SERVICE_WORKER_SHELL_ROUTES = /const SHELL_ROUTES = \[[^\n]*\]/

// Everything the shell HTML boots from. Precaching exactly this set means the
// reload that follows a service-worker update paints from disk instead of
// re-downloading the bundle, which is what turned every deploy into a blank
// launch. Deliberately not the whole build: other per-route chunks stay lazy.
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

// Only files produced in the static export may authorize a shared cache fill.
// Keep this separate from precaching: route chunks and unused fonts stay lazy.
const publicDelivery = async (root) => {
  const files = []
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), url)
      else if (entry.isFile()) files.push(url)
    }
  }
  await walk(path.join(root, 'dist'))
  const fixed = new Set(['/manifest.webmanifest', '/favicon.ico', '/apple-touch-icon.png',
    '/pwa-192.png', '/pwa-512.png', '/pwa-512-maskable.png', '/boot-logo.png'])
  const assets = files.filter((url) => url.startsWith('/assets/') || url.startsWith('/_expo/static/') || fixed.has(url)).sort()
  return {
    assets,
    hashes: Object.fromEntries(await Promise.all(['/', ...assets].map(async (url) => [
      url, createHash('sha256').update(await readFile(path.join(root, 'dist', url === '/' ? 'index.html' : url))).digest('hex'),
    ]))),
    routes: [...new Set(files.filter((url) => url.endsWith('.html') && !url.includes('+not-found'))
      .flatMap((url) => [url, url.replace(/\/index\.html$/, '/').replace(/\.html$/, '')]))].sort(),
  }
}

const bootAssets = (html, assets) => {
  const urls = new Set(['/'])
  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (isSameOriginPath(src)) urls.add(src)
  }
  for (const [, href] of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)) {
    if (isSameOriginPath(href)) urls.add(href)
  }
  // The boot shell paints its brand mark before any bundle runs.
  for (const [, url] of html.matchAll(/<(?:link[^>]+rel="manifest"[^>]+href|img[^>]+src)="([^"]+)"/g)) {
    if (isSameOriginPath(url) && (/manifest[^/]*\.webmanifest$/.test(url) || /boot-logo[^/]*\.png$/.test(url))) urls.add(url)
  }
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
  if (!SERVICE_WORKER_PUBLIC_ASSETS.test(source) || !SERVICE_WORKER_PUBLIC_HASHES.test(source) || !SERVICE_WORKER_SHELL_ROUTES.test(source)) {
    throw new Error('Service worker is missing its public delivery allowlists')
  }
  // Logout must reach usable public controls even if the session began at signup.
  // Use the export's full sign-in dependency graph, with the same required-byte checks.
  const html = (await Promise.all(['index.html', 'sign-in.html'].map((file) =>
    readFile(path.join(root, 'dist', file), 'utf8')))).join('\n')
  const retained = await readFile(path.join(root, 'dist', 'release-compatibility.json'), 'utf8')
    .then(value => new Set(JSON.parse(value).files.map(file => `/${file.path}`)))
    .catch(error => { if (error.code === 'ENOENT') return new Set(); throw error })
  const assets = (await assetUrls(root)).filter(url => !retained.has(url))
  const urls = bootAssets(html, { fonts: await referencedFonts(root, assets) })
  const delivery = await publicDelivery(root)
  if (urls.some((url) => !delivery.hashes[url] || (url !== '/' && !delivery.assets.includes(url)))) {
    throw new Error('Required boot asset is missing from the public build')
  }
  if (urls.length < 3) {
    throw new Error('Release build produced no boot assets to precache; the shell HTML is probably malformed')
  }
  await writeFile(
    workerPath,
    source.replace(SERVICE_WORKER_PRECACHE, `const PRECACHE_URLS = ${JSON.stringify(urls)}`)
      .replace(SERVICE_WORKER_PUBLIC_ASSETS, `const PUBLIC_ASSET_URLS = ${JSON.stringify(delivery.assets)}`)
      .replace(SERVICE_WORKER_PUBLIC_HASHES, `const PUBLIC_ASSET_HASHES = ${JSON.stringify(delivery.hashes)}`)
      .replace(SERVICE_WORKER_SHELL_ROUTES, `const SHELL_ROUTES = ${JSON.stringify(delivery.routes)}`),
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

const contentAddressPublicFiles = async (root) => {
  const dist = path.join(root, 'dist')
  const destination = path.join(dist, 'assets/pwa')
  await mkdir(destination, { recursive: true })
  const replacements = new Map()
  const emit = async (file, bytes) => {
    const extension = path.extname(file)
    const stem = path.basename(file, extension)
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    const url = `/assets/pwa/${stem}.${digest}${extension}`
    await writeFile(path.join(dist, url), bytes)
    replacements.set(`/${file}`, url)
  }
  for (const file of ['boot-logo.png', 'pwa-192.png', 'pwa-512.png', 'pwa-512-maskable.png', 'apple-touch-icon.png', 'favicon.ico']) {
    const bytes = await readFile(path.join(dist, file)).catch(() => null)
    if (bytes) await emit(file, bytes)
  }
  const scripts = path.join(dist, '_expo/static/js/web')
  for (const file of await readdir(scripts).catch(() => [])) {
    if (/^entry-[^.]+\.js$/.test(file)) await emit(`_expo/static/js/web/${file}`, await readFile(path.join(scripts, file)))
  }
  const manifestFile = await readFile(path.join(dist, 'manifest.webmanifest'), 'utf8').catch(() => null)
  if (manifestFile) {
    const manifest = JSON.parse(manifestFile)
    for (const icon of manifest.icons ?? []) icon.src = replacements.get(icon.src) ?? icon.src
    await emit('manifest.webmanifest', Buffer.from(JSON.stringify(manifest)))
  }
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.name.endsWith('.html')) {
        let html = await readFile(file, 'utf8')
        for (const [before, after] of replacements) html = html.replaceAll(`"${before}"`, `"${after}"`)
        await writeFile(file, html)
      }
    }
  }
  await walk(dist)
}

const setDocumentVersion = async (root, version) => {
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.name.endsWith('.html')) {
        const html = await readFile(file, 'utf8')
        await writeFile(file, html.replace(/(<meta name="pancake-release" content=")[^"]*(")/g, `$1${version}$2`))
      }
    }
  }
  await walk(path.join(root, 'dist'))
}

export const stampReleaseProvenance = async ({
  root = process.cwd(),
  previousRelease = process.env.PANCAKE_PREVIOUS_RELEASE_ROOT,
  commitSha = process.env.E2E_EXPECTED_RELEASE_SHA || process.env.PANCAKE_RELEASE_SHA ||
    process.env.E2E_RELEASE_SHA || process.env.GITHUB_SHA || repositoryCommit(root),
} = {}) => {
  if (!fullSha(commitSha)) throw new Error('Release marker requires a full commit SHA')
  // Before the digest, so the precached set is covered by the cache version.
  await compactDocumentAssets(root)
  await contentAddressPublicFiles(root)
  await prepareReleaseCompatibility(root, previousRelease)
  await setDocumentVersion(root, 'pancake-build')
  await setServiceWorkerPrecache(root)
  await setServiceWorkerVersion(root, 'pancake-build')
  const cacheDigest = await digestReleaseBundle(root)
  const version = `pancake-${commitSha.slice(0, 12)}-${cacheDigest.slice(0, 12)}`
  await setDocumentVersion(root, version)
  await setServiceWorkerPrecache(root)
  await setServiceWorkerVersion(root, version)
  const marker = {
    commitSha: commitSha.toLowerCase(),
    bundleDigest: await digestReleaseBundle(root),
    deploymentInputs: FRONTEND_DEPLOYMENT_INPUTS,
    artifact: await createReleaseArtifactManifest(root),
  }
  await writeFile(path.join(root, 'dist', 'release-provenance.json'), `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const marker = await stampReleaseProvenance()
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `bundle_digest=${marker.bundleDigest}\n`)
  }
  console.log(JSON.stringify({ commitSha: marker.commitSha, bundleDigest: marker.bundleDigest, deploymentInputs: marker.deploymentInputs }))
}
