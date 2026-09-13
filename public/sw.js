/* Pancake PWA service worker.
 * - Instant app shell: navigations serve the cached "/" SPA shell immediately
 *   (no network round-trip on the critical path) and revalidate it in the
 *   background. New deploys still take over via the version-stamped worker
 *   update + controllerchange reload in +html.tsx.
 * - Instant relaunch after a deploy: install precaches the shell *and* the
 *   scripts/styles it boots from, so the reload that follows an update paints
 *   from cache instead of re-downloading the whole bundle over the network.
 * - Content-hashed assets are cache-first (the filename is the version, so a
 *   hit can never be stale); everything else is stale-while-revalidate.
 * - Cross-origin requests (Supabase, realtime, external APIs) are never
 *   intercepted — the app's own offline/empty states handle them.
 */
// Both constants are replaced at build time by
// scripts/stamp-release-provenance.mjs, so each deploy gets its own caches,
// precaches its own bundle, and drops the previous deploy's entries.
const VERSION = 'pancake-dev'
const PRECACHE_URLS = ['/']

const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`
const SHELL_URL = '/'
// Content-hashed output: the filename changes whenever the bytes do. Covers the
// bundle (/_expo/static) and the fonts and images the bundle asks for (/assets).
const IMMUTABLE = /^\/(?:_expo\/static|assets)\//

// Only a same-origin success may enter a cache. The host rewrites every unknown
// path to +not-found.html with HTTP 200, so after a deploy a request for a
// previous release's hashed asset comes back as an HTML document with
// response.ok === true. Storing that under an immutable asset URL would serve a
// SyntaxError from cache for the life of the release, so anything that looks
// like a document is refused everywhere except the shell itself.
function isDocument(response) {
  const type = response.headers && response.headers.get('content-type')
  return typeof type === 'string' && /text\/html/i.test(type)
}

function cacheable(response, { allowDocument = false } = {}) {
  if (!response || !response.ok) return false
  if (response.type && response.type !== 'basic' && response.type !== 'default') return false
  return allowDocument || !isDocument(response)
}

// Fetch one precache entry. A non-ok (or document-shaped) response is permanent
// (a stale manifest entry) and is skipped; a rejected fetch is the network being
// unavailable, and must fail the install rather than half-populate the cache.
async function precache(cache, url, options) {
  const response = await fetch(new Request(url, { cache: 'reload' }))
  if (!cacheable(response, options)) return
  await cache.put(url, response)
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Deliberately allowed to reject. Activation deletes the previous
      // release's caches, so installing on a flaky link and then activating
      // would leave a launch with neither release's assets. A rejected install
      // is discarded and retried on the next update check, and the previous
      // worker keeps serving in the meantime.
      const shell = await caches.open(SHELL_CACHE)
      await precache(shell, SHELL_URL, { allowDocument: true })
      // The shell is the one entry that cannot be skipped: without it this
      // release has nothing to serve offline once the old caches are dropped.
      if (!(await shell.match(SHELL_URL))) throw new Error('shell precache failed; install aborted')
      const assets = await caches.open(ASSET_CACHE)
      await Promise.all(
        PRECACHE_URLS.filter((url) => url !== SHELL_URL).map((url) => precache(assets, url)),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only after install precached this version — dropping the previous
      // deploy's entries before that would strand a launch with no assets.
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PANCAKE_WORKER_VERSION') return
  event.ports?.[0]?.postMessage({ version: VERSION })
})

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (cacheable(response)) cache.put(request, response.clone()).catch(() => {})
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (cacheable(response)) cache.put(request, response.clone()).catch(() => {})
      return response
    })
    .catch((error) => {
      // A cold cache plus a dead network must reject, not resolve undefined:
      // respondWith(undefined) is a hard failure the outer fallback never sees.
      if (cached) return cached
      throw error
    })
  return cached || network
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // never touch API / realtime

  // App shell for navigations: cached shell first for an instant paint, with a
  // background revalidation. Falling back to network when the cache is cold.
  if (request.mode === 'navigate') {
    const refreshShell = () =>
      fetch(request).then((response) => {
        // Only refresh the cached shell from a successful navigation to "/"
        // itself. The web build is a per-route static export and the host
        // rewrites unknown paths to +not-found.html with HTTP 200, so caching
        // any other route's document here would poison the offline shell
        // (worst case: offline launches boot into the 404 screen).
        if (
          response && response.ok && response.type === 'basic' &&
          new URL(response.url || request.url).pathname === SHELL_URL
        ) {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy)).catch(() => {})
        }
        return response
      })
    event.respondWith(
      caches.match(SHELL_URL).then((cached) => {
        if (cached) {
          // Serve instantly; keep the cached copy fresh off the critical path.
          event.waitUntil(refreshShell().catch(() => undefined))
          return cached
        }
        return refreshShell().catch(async (error) => {
          const fallback = await caches.match(request)
          if (fallback) return fallback
          throw error
        })
      }).catch(() => fetch(request)),
    )
    return
  }

  event.respondWith(
    (IMMUTABLE.test(url.pathname) ? cacheFirst(request) : staleWhileRevalidate(request))
      // A cache that is evicted, disabled, or corrupt must never break a load.
      .catch(() => fetch(request)),
  )
})
