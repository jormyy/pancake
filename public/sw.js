/* Pancake PWA service worker.
 * - Instant app shell: navigations serve the cached "/" SPA shell immediately
 *   (no network round-trip on the critical path) and revalidate it in the
 *   background. New deploys still take over via the version-stamped worker
 *   update + controllerchange reload in +html.tsx.
 * - Fast repeat loads: same-origin static assets (hashed _expo / assets /
 *   fonts / images) use stale-while-revalidate.
 * - Cross-origin requests (Supabase, realtime, external APIs) are never
 *   intercepted — the app's own offline/empty states handle them.
 */
// Replaced with the release commit by scripts/stamp-release-provenance.mjs at
// build time, so each deploy gets its own caches and drops the previous ones.
const VERSION = 'pancake-dev'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`
const SHELL_URL = '/'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(SHELL_URL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

function staleWhileRevalidate(request) {
  return caches.open(ASSET_CACHE).then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone())
          return response
        })
        .catch(() => cached)
      return cached || network
    }),
  )
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
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy))
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
      }),
    )
    return
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request))
})
