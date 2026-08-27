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

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE)
      await shell.add(SHELL_URL).catch(() => {})
      // Precache the boot path so the post-update reload is served from disk.
      // Individually, so one 404 from a stale manifest cannot fail the install
      // and leave the previous worker serving a shell it no longer matches.
      const assets = await caches.open(ASSET_CACHE)
      await Promise.all(
        PRECACHE_URLS.filter((url) => url !== SHELL_URL).map((url) =>
          assets.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
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
  if (response && response.ok) cache.put(request, response.clone()).catch(() => {})
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {})
      return response
    })
    .catch(() => cached)
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
        return refreshShell().catch(() => caches.match(request))
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
