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
  if (/^\/(?:api|auth|rest|functions|storage|realtime|graphql)(?:\/|$)/.test(pathname)) return false
  return SHELL_ROUTES.some((route) => {
    const expected = route.replace(/\/$/, '').split('/')
    const actual = pathname.replace(/\/$/, '').split('/')
    return expected.length === actual.length && expected.every((part, index) =>
      part === actual[index] || (/^\[[^\]]+\]$/.test(part) && !!actual[index]))
  }) || !/\.[^/]+\/?$/.test(pathname)
}

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

async function cachedBuildAsset(url, signal) {
  const digest = PUBLIC_ASSET_HASHES[new URL(url, self.location.origin).pathname]
  if (!digest) return undefined
  try {
    const response = await fetch(new Request(url, {
      credentials: 'omit', redirect: 'error', mode: 'same-origin', cache: 'force-cache', signal,
    }))
    if (cacheable(response) && await matchesBuild(response, digest)) return response
  } catch {}
  return undefined
}

async function publicAssetFetch(url) {
  const cached = await cachedBuildAsset(url)
  if (cached) return cached
  const response = await publicFetch(url)
  const digest = PUBLIC_ASSET_HASHES[new URL(url, self.location.origin).pathname]
  if (digest && cacheable(response) && !(await matchesBuild(response, digest))) {
    return new Response('Release asset unavailable', { status: 502 })
  }
  return response
}

async function safeMatch(cache, key, options) {
  const response = await cache.match(key)
  if (!response) return undefined
  const url = typeof key === 'string' ? key : key.url
  const digest = PUBLIC_ASSET_HASHES[new URL(url, self.location.origin).pathname]
  if (cacheable(response, options) && (!digest || await matchesBuild(response, digest))) return response
  await cache.delete(key)
  return undefined
}

async function bootResponse(url, signal, previous = []) {
  const shell = url === SHELL_URL
  const cached = !shell && (await previousBuildAsset(url, previous) || await cachedBuildAsset(url, signal))
  if (cached) return cached
  const response = await publicFetch(url, signal)
  if (!cacheable(response, { allowDocument: shell }) ||
      (shell && !/text\/html/i.test(response.headers.get('content-type') || '')) ||
      !(await matchesBuild(response, PUBLIC_ASSET_HASHES[url]))) {
    throw new Error(`${shell ? 'shell' : 'asset'} precache rejected: ${url}`)
  }
  return response
}

async function previousBuildAsset(url, previous) {
  for (const cache of previous) {
    const response = await cache.match(url)
    if (cacheable(response) && await matchesBuild(response, PUBLIC_ASSET_HASHES[url])) return response
  }
  return undefined
}

async function previousPublicCaches() {
  const names = (await caches.keys()).filter((name) => name.startsWith('pancake-') &&
    name.endsWith('-public-v1-assets') && name !== ASSET_CACHE)
  // Failed installs can leave their caches until a later activation removes them.
  // Inspect only the newest prior generations, so old leftovers never block an update.
  return Promise.all(names.reverse().slice(0, CARRY_GENERATION_LIMIT)
    .map((name) => caches.open(name)))
}

async function carryPublicAssets(assets, previous) {
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

async function activateWhenSafe() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const holds = await Promise.all(windows.filter(client => new URL(client.url).origin === self.location.origin).map(client =>
    new Promise(resolve => {
      const channel = new MessageChannel()
      let settled = false
      const finish = held => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        channel.port1.close()
        resolve(held)
      }
      const timer = setTimeout(() => finish(true), 750)
      channel.port1.onmessage = event => finish(event.data?.held !== false)
      try { client.postMessage({ type: 'PANCAKE_UPDATE_STATE' }, [channel.port2]) }
      catch { finish(true) }
    })
  ))
  if (!holds.some(Boolean)) void self.skipWaiting()
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
      const previous = await Promise.race([previousPublicCaches(), deadline])
      const responses = await Promise.race([
        Promise.all(PRECACHE_URLS.map((url) => bootResponse(url, controller.signal, previous))),
        deadline,
      ])
      const shell = await caches.open(SHELL_CACHE)
      const assets = await caches.open(ASSET_CACHE)
      // A killed worker can leave partial versioned caches. Always refill the
      // entire verified set on retry; activation, not cache existence, commits it.
      await Promise.race([
        (async () => {
          for (let index = 0; index < PRECACHE_URLS.length; index++) {
            const url = PRECACHE_URLS[index]
            await (url === SHELL_URL ? shell : assets).put(url, responses[index])
          }
          await carryPublicAssets(assets, previous)
        })(),
        deadline,
      ])
      await activateWhenSafe()
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await self.clients.claim() } catch { return }
    try {
      const keys = await caches.keys()
      await Promise.allSettled(keys.filter((key) => key.startsWith('pancake-') &&
        key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key)))
    } catch {}
  })())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'PANCAKE_ACTIVATE_WHEN_SAFE') { event.waitUntil(activateWhenSafe()); return }
  if (event.data?.type !== 'PANCAKE_WORKER_VERSION') return
  // controllerchange can precede activation. Keep the current page visible
  // until the replacement worker can serve the reload without waiting.
  event.waitUntil(new Promise((resolve) => {
    const worker = self.registration.active
    if (!worker) { resolve(); return }
    const replyWhenActive = () => {
      if (worker.state !== 'activated' && worker.state !== 'redundant') return
      worker.removeEventListener('statechange', replyWhenActive)
      if (worker.state === 'activated') event.ports?.[0]?.postMessage({ version: VERSION, draftRecoveryVersion: 1 })
      resolve()
    }
    worker.addEventListener('statechange', replyWhenActive)
    replyWhenActive()
  }))
})

async function notifyClient(event, type) {
  const client = event.clientId && await self.clients.get(event.clientId)
  if (client) client.postMessage({ type })
}

function scriptRequest(request) {
  return request.destination === 'script' || /\.(?:m?js)$/.test(new URL(request.url).pathname)
}

async function rejectMissingScript(response, request, event) {
  if (!scriptRequest(request) || (response.ok && !response.redirected &&
      !/text\/html/i.test(response.headers.get('content-type') || ''))) return response
  event.waitUntil(notifyClient(event, 'PANCAKE_ASSET_MISS'))
  return new Response('Release asset unavailable', {
    status: response.ok ? 502 : response.status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

async function fetchScript(request, event) {
  try {
    return await rejectMissingScript(await publicAssetFetch(request.url), request, event)
  } catch (error) {
    if (scriptRequest(request)) event.waitUntil(notifyClient(event, 'PANCAKE_ASSET_MISS'))
    throw error
  }
}

async function assetResponse(request, event) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await safeMatch(cache, request)
  if (cached) return cached
  const response = await fetchScript(request, event)
  if (cacheable(response)) await cache.put(request, response.clone()).catch(() => {})
  return response
}

async function onlineShell(event) {
  const response = await publicFetch(event.request.url)
  if (!cacheable(response, { allowDocument: true }) ||
      !/text\/html/i.test(response.headers.get('content-type') || '')) {
    throw new Error('Public online shell unavailable')
  }
  if (self.registration) event.waitUntil(self.registration.update().catch(() => {}))
  return response
}

async function shellForRoute(response, requestUrl) {
  if (new URL(requestUrl).pathname === SHELL_URL) return response
  const html = await response.clone().text()
  const clientShell = html.replace(/(globalThis\.__EXPO_ROUTER_HYDRATE__\s*=\s*)true\b/g, '$1false')
  if (clientShell === html) return response
  const headers = new Headers(response.headers)
  for (const header of ['content-length', 'content-encoding', 'etag']) headers.delete(header)
  return new Response(clientShell, { status: response.status, statusText: response.statusText, headers })
}

async function shellResponse(event) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await safeMatch(cache, SHELL_URL, { allowDocument: true })
  if (cached) return shellForRoute(cached, event.request.url)
  try {
    const response = await bootResponse(SHELL_URL)
    await cache.put(SHELL_URL, response.clone()).catch(() => {})
    return shellForRoute(response, event.request.url)
  } catch {
    return onlineShell(event)
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || privateRequest(request)) return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    if (!shellRoute(url.pathname)) return
    event.respondWith(shellResponse(event).catch(() => onlineShell(event)))
  } else if (!url.search && PUBLIC_ASSETS.has(url.pathname)) {
    event.respondWith(assetResponse(request, event).catch(() => fetchScript(request, event)))
  } else if (scriptRequest(request)) {
    event.respondWith(fetchScript(request, event))
  }
})

// ---------------------------------------------------------------------------
// A queued push can arrive after logout or an account switch. The worker
// cannot trust that its recipient still owns this browser. Keep all browser
// notifications generic, including payloads queued by an older server.
self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Pancake', {
      tag: 'pancake',
      renotify: true,
      body: 'Open Pancake to check for updates.',
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
      data: { url: '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = '/'
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

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        client.postMessage({ type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' })
      }
    }
  })())
})
