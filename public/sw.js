/* Pancake PWA service worker.
 * - Offline app shell: navigations are network-first and fall back to the
 *   cached "/" SPA shell when offline.
 * - Fast repeat loads: same-origin static assets (hashed _expo / assets /
 *   fonts / images) use stale-while-revalidate.
 * - Cross-origin requests (Supabase, the Railway API, realtime) are never
 *   intercepted — the app's own offline/empty states handle them.
 */
const VERSION = 'pancake-v1'
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

  // App shell for navigations: network-first, fall back to cached shell offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy))
          return response
        })
        .catch(() => caches.match(SHELL_URL).then((r) => r || caches.match(request))),
    )
    return
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request))
})
