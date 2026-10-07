/* Pancake PWA service worker. Shared caches hold only anonymous, build-owned
 * delivery files. Account data stays in the application's scoped caches.
 * The build stamps exact public files and static shell routes; a URL extension
 * or a successful response alone never authorizes shared caching.
 */
const VERSION = 'pancake-dev'
const PRECACHE_URLS = ['/']
const PUBLIC_ASSET_URLS = []
const PUBLIC_ASSET_HASHES = {}
const SHELL_ROUTES = ['/']

// A policy epoch prevents even a matching release URL from reading legacy data.
const SHELL_CACHE = `${VERSION}-public-v1-shell`
const ASSET_CACHE = `${VERSION}-public-v1-assets`
const SHELL_URL = '/'
const BOOT_TIMEOUT_MS = 30000
const CARRY_BYTES_LIMIT = 64 * 1024 * 1024
const CARRY_GENERATION_LIMIT = 8
const PUBLIC_ASSETS = new Set(PUBLIC_ASSET_URLS)
const IMMUTABLE = /^\/(?:_expo\/static|assets)\//
const PRIVATE_DIRECTIVES = /(?:^|,)\s*(?:private|no-store|no-cache)\b/i

function cacheable(response, { allowDocument = false } = {}) {
  if (!response || !response.ok || response.redirected) return false
  if (response.type && response.type !== 'basic' && response.type !== 'default') return false
  if (PRIVATE_DIRECTIVES.test(response.headers.get('cache-control') || '')) return false
  if (response.headers.has('set-cookie')) return false
  const vary = response.headers.get('vary') || ''
  if (vary.split(',').some((name) => name.trim() && name.trim().toLowerCase() !== 'accept-encoding')) return false
  return allowDocument || !/text\/html/i.test(response.headers.get('content-type') || '')
}

function privateRequest(request) {
  return ['authorization', 'proxy-authorization', 'cookie', 'apikey', 'x-api-key', 'range']
    .some((header) => request.headers.has(header)) || request.cache === 'no-store' ||
    PRIVATE_DIRECTIVES.test(request.headers.get('cache-control') || '') ||
    /no-cache/i.test(request.headers.get('pragma') || '')
}

function shellRoute(pathname) {
  return SHELL_ROUTES.some((route) => {
    const expected = route.replace(/\/$/, '').split('/')
    const actual = pathname.replace(/\/$/, '').split('/')
    return expected.length === actual.length && expected.every((part, index) =>
      part === actual[index] || (/^\[[^\]]+\]$/.test(part) && !!actual[index]))
  })
}

// Strip identity and bypass the HTTP cache: a legacy authenticated response
// can live there even after the old worker's Cache Storage is removed.
// Only this worker's validated public cache may supply a shared hit.
const publicFetch = (url, signal) =>
  fetch(new Request(url, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal }))

async function matchesBuild(response, digest) {
  if (!digest) return false
  const bytes = await response.clone().arrayBuffer()
  return matchesDigest(bytes, digest)
}

async function matchesDigest(bytes, digest) {
  const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return actual === digest
}

async function publicAssetFetch(url) {
  try {
    return await publicFetch(url)
  } catch (error) {
    // A first visit can load a lazy chunk before the worker takes control.
    // Keep those public HTTP-cache bytes usable offline, but never trust a
    // legacy response merely because its URL or headers look public.
    const digest = PUBLIC_ASSET_HASHES[new URL(url, self.location.origin).pathname]
    if (!digest) throw error
    const response = await fetch(new Request(url, {
      credentials: 'omit', redirect: 'error', mode: 'same-origin', cache: 'only-if-cached',
    }))
    if (!cacheable(response)) throw error
    if (!(await matchesBuild(response, digest))) throw error
    return response
  }
}

async function safeMatch(cache, key, options) {
  const response = await cache.match(key)
  if (!response) return undefined
  if (cacheable(response, options)) return response
  await cache.delete(key)
  return undefined
}

async function bootResponse(url, signal) {
  const response = await publicFetch(url, signal)
  const shell = url === SHELL_URL
  if (!cacheable(response, { allowDocument: shell }) ||
      (shell && !/text\/html/i.test(response.headers.get('content-type') || '')) ||
      !(await matchesBuild(response, PUBLIC_ASSET_HASHES[url]))) {
    throw new Error(`${shell ? 'shell' : 'asset'} precache rejected: ${url}`)
  }
  return response
}

async function carryPublicAssets(assets) {
  const names = (await caches.keys()).filter((name) => name.startsWith('pancake-') &&
    name.endsWith('-public-v1-assets') && name !== ASSET_CACHE)
  if (names.length > CARRY_GENERATION_LIMIT) throw new Error('too many prior public caches')
  const previous = await Promise.all(names.reverse().map((name) => caches.open(name)))
  let remaining = CARRY_BYTES_LIMIT
  // Only current manifest entries can cross a release boundary. Revalidate
  // headers and bytes, including orphan entries from an interrupted install.
  for (const url of PUBLIC_ASSETS) {
    if (PRECACHE_URLS.includes(url) || !PUBLIC_ASSET_HASHES[url]) continue
    for (const cache of [assets, ...previous]) {
      const response = await cache.match(url)
      if (response && cache === assets) await assets.delete(url)
      if (!cacheable(response) || !response.body) continue
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > remaining) {
          void reader.cancel()
          throw new Error('public asset carryover exceeds byte limit')
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      if (!(await matchesDigest(bytes, PUBLIC_ASSET_HASHES[url]))) continue
      await assets.put(url, new Response(bytes, { headers: response.headers }))
      remaining -= size
      break
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // A release is usable only when every required URL belongs to its build.
    // Never downgrade an unknown or unsafe boot file to an optional download.
    if (!PRECACHE_URLS.includes(SHELL_URL) || PRECACHE_URLS.some((url) =>
      (url !== SHELL_URL && !PUBLIC_ASSETS.has(url)) || !PUBLIC_ASSET_HASHES[url])) {
      throw new Error('invalid required boot manifest')
    }
    const controller = new AbortController()
    let timer
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('required boot precache timed out'))
        }, BOOT_TIMEOUT_MS)
      })
      // Hold verified responses until the whole set succeeds. A failed fetch
      // cannot write a new shell over a usable release, even on a same-version retry.
      const responses = await Promise.race([
        Promise.all(PRECACHE_URLS.map((url) => bootResponse(url, controller.signal))),
        deadline,
      ])
      const shell = await caches.open(SHELL_CACHE)
      const assets = await caches.open(ASSET_CACHE)
      // A killed worker can leave partial versioned caches. Always refill the
      // entire verified set on retry; activation, not cache existence, commits it.
      await Promise.race([
        (async () => {
          await Promise.all(PRECACHE_URLS.map((url, index) =>
            (url === SHELL_URL ? shell : assets).put(url, responses[index])))
          await carryPublicAssets(assets)
        })(),
        deadline,
      ])
      await self.skipWaiting()
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith('pancake-') &&
      key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PANCAKE_WORKER_VERSION') return
  event.ports?.[0]?.postMessage({ version: VERSION })
})

async function assetResponse(request, event, immutable) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await safeMatch(cache, request)
  if (cached && immutable) return cached
  const network = publicAssetFetch(request.url).then(async (response) => {
    if (cacheable(response)) await cache.put(request, response.clone()).catch(() => {})
    else if (response && response.ok) await cache.delete(request).catch(() => {})
    return response
  })
  event.waitUntil(network.catch(() => undefined))
  return cached || network
}

async function shellResponse(event) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await safeMatch(cache, SHELL_URL, { allowDocument: true })
  const network = bootResponse(SHELL_URL).then(async (response) => {
    await cache.put(SHELL_URL, response.clone()).catch(() => {})
    return response
  })
  event.waitUntil(network.catch(() => undefined))
  return cached || network
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || privateRequest(request)) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    if (!shellRoute(url.pathname)) return
    event.respondWith(shellResponse(event).catch(() => bootResponse(SHELL_URL)))
  } else if (!url.search && PUBLIC_ASSETS.has(url.pathname)) {
    event.respondWith(assetResponse(request, event, IMMUTABLE.test(url.pathname))
      .catch(() => publicFetch(request.url)))
  }
})

// ---------------------------------------------------------------------------
// Web Push (installed PWA). Payloads come from supabase/functions/_shared/
// webPushDelivery.ts: { title, body, url, category, data }.
// Every push must show a notification — Safari revokes push permission from
// sites that receive pushes silently.
// ---------------------------------------------------------------------------

// Only same-origin in-app paths may be opened from a notification tap.
function notificationPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { body: event.data ? event.data.text() : '' }
  }
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Pancake'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      data: { url: notificationPath(payload.url) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = notificationPath(event.notification.data && event.notification.data.url)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const client = windows.find((candidate) => new URL(candidate.url).origin === self.location.origin)
      if (client) {
        // Route inside the running SPA (hooks/use-web-push-notifications.ts)
        // rather than reloading it.
        await client.focus()
        client.postMessage({ type: 'PANCAKE_NOTIFICATION_CLICK', url: path })
        return
      }
      await self.clients.openWindow(path)
    })(),
  )
})
