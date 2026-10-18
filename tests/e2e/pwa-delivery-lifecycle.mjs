import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { build as bundle } from 'esbuild'
import { chromium, webkit, devices } from 'playwright'
import { readPwaRelease } from './pwa-update-release.mjs'

const root = process.env.TASK_DIR
const directory = `${root}/evidence/stage2/lane-b/${process.env.PWA_RUN_NAME ?? 'lifecycle'}`
await mkdir(directory, { recursive: true })
const before = await readPwaRelease(`${root}/web-update`)
const after = await readPwaRelease(`${root}/web-after`)
assert.notEqual(before.version, after.version)
const beforeWorker = await readFile(`${root}/web-update/sw.js`, 'utf8')
const afterWorker = await readFile(`${root}/web-after/sw.js`, 'utf8')
const assets = text => JSON.parse(/const PUBLIC_ASSET_URLS = (\[[^\n]*\])/.exec(text)[1])
const missingChunk = assets(beforeWorker).find(url => url.endsWith('.js') && !assets(afterWorker).includes(url) && !before.bootHashes[url])
assert(missingChunk, 'Two builds must contain a changed lazy route chunk')
const guard = (await bundle({ entryPoints: ['lib/pwa-update-guard.ts'], bundle: true, format: 'esm', write: false })).outputFiles[0].text
const origin = 'http://127.0.0.1:56853'
let current = 'before'
let releaseWrites = []
let releaseImages = []
let holdImage = false
const requests = []
const server = createServer((request, response) => {
  const pathname = new URL(request.url, origin).pathname
  if (pathname === '/_guard.mjs') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(guard); return }
  if (pathname === '/_write') { releaseWrites.push(() => { response.writeHead(200); response.end('settled') }); return }
  if (pathname === '/_load.png') {
    const reply = () => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJawAAAAASUVORK5CYII=', 'base64')) }
    if (holdImage) releaseImages.push(reply)
    else reply()
    return
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
  const selected = current
  const forward = httpRequest({ hostname: '127.0.0.1', port: selected === 'before' ? 56850 : 56851, path: request.url,
    headers: { ...request.headers, host: '127.0.0.1' } }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers)
    incoming.pipe(response)
    response.on('finish', () => requests.push({ pathname, build: selected, status: incoming.statusCode, contentType: incoming.headers['content-type'] }))
  })
  forward.on('error', error => { response.writeHead(502); response.end(String(error)) })
  forward.end()
})
await new Promise(resolve => server.listen(56853, '127.0.0.1', () => resolve(undefined)))
const results = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) { if (await check()) return; await pause(250) }
  throw new Error(`Timed out: ${label}`)
}
const version = page => page.evaluate(() => new Promise(resolve => {
  if (!navigator.serviceWorker.controller) { resolve(null); return }
  const channel = new MessageChannel()
  channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data.version) }
  navigator.serviceWorker.controller.postMessage({ type: 'PANCAKE_WORKER_VERSION' }, [channel.port2])
  setTimeout(() => { channel.port1.close(); resolve(null) }, 3000)
}))
const ready = async page => {
  await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor({ timeout: 45000 })
  await until(async () => await version(page) === before.version, 'before worker')
}
const marker = page => page.evaluate(() => document.querySelector('meta[name="pancake-release"]')?.getAttribute('content'))
try {
  for (const engine of ['chromium', 'webkit']) {
    for (const scenario of (process.env.PWA_SCENARIOS ?? 'held-write,missing-chunk,early-controller,missing-shell,poisoned-cache').split(',')) {
      current = 'before'
      holdImage = false
      const context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(`${directory}/${engine}-${scenario}-${Date.now()}`, {
        headless: true, ...(engine === 'webkit' ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }),
      })
      const result = { engine, scenario, errors: [] }
      results.push(result)
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      page.on('pageerror', error => result.errors.push(String(error)))
      result.consoleErrors = []
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()) })
      await context.addInitScript(() => {
        Object.assign(window, { documentInstance: Math.random() })
        const state = Object.assign(window, { workerEvents: [] })
        const register = navigator.serviceWorker.register.bind(navigator.serviceWorker)
        navigator.serviceWorker.register = (...args) => register(...args).then(registration => {
          const worker = registration.installing
          state.workerEvents.push({ state: worker?.state ?? registration.active?.state })
          worker?.addEventListener('statechange', () => state.workerEvents.push({ state: worker.state }))
          return registration
        }, error => { state.workerEvents.push({ error: String(error) }); throw error })
        const fetchOriginal = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
          if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External API forbidden')
          return fetchOriginal(input, init)
        }
      })
      try {
        await page.goto(origin)
        await ready(page)
        const initial = await page.evaluate(() => Reflect.get(window, 'documentInstance'))
        if (scenario === 'poisoned-cache') {
          current = 'after'
          await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update())
          await until(async () => await marker(page).catch(() => null) === after.version, 'updated page for cache poison')
          const asset = Object.keys(after.bootHashes).find(url => url.endsWith('.js'))
          const digest = await page.evaluate(async ({ asset, version }) => {
            const cache = await caches.open(version + '-public-v1-assets')
            await cache.put(asset, new Response('poisoned cached module', { headers: { 'content-type': 'text/javascript' } }))
            const response = await fetch(asset, { credentials: 'omit' })
            return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('')
          }, { asset, version: after.version })
          assert.equal(digest, after.bootHashes[asset])
          result.poisonRejected = true
        } else if (scenario === 'missing-shell') {
          await page.evaluate(async () => {
            for (const name of await caches.keys()) if (name.endsWith('-public-v1-shell')) await (await caches.open(name)).delete('/')
          })
          current = 'after'
          await page.goto(`${origin}/sign-in`)
          await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor()
          assert.equal(await marker(page), after.version)
          result.onlineRecovered = true
        } else if (scenario === 'early-controller') {
          holdImage = true
          await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
              if (sessionStorage.getItem('held-load')) return
              sessionStorage.setItem('held-load', '1')
              const image = document.createElement('img')
              image.src = '/_load.png'
              document.body.appendChild(image)
            }, { once: true })
          })
          await page.goto(origin, { waitUntil: 'domcontentloaded' })
          await until(async () => releaseImages.length > 0, 'pending load image')
          current = 'after'
          await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update())
          await until(async () => await version(page) === after.version, 'new controller before load')
          result.readyStateAtController = await page.evaluate(() => document.readyState)
          assert.notEqual(result.readyStateAtController, 'complete')
          assert.equal(await marker(page), before.version)
          holdImage = false
          releaseImages.splice(0).forEach(release => release())
          await until(async () => await marker(page).catch(() => null) === after.version, 'early update reload')
          result.reconciled = true
        } else {
          await page.evaluate(async () => {
            const guardUrl = '/_guard.mjs'
            const guard = await import(guardUrl)
            const releaseUpdate = guard.holdPwaUpdate('pending local mutation')
            Object.assign(window, { write: fetch('/_write', { method: 'POST' }).then(response => response.text()).then(releaseUpdate) })
          })
          current = 'after'
          if (scenario === 'missing-chunk') {
            await page.evaluate(url => { Object.assign(window, { oldChunk: import(url).catch(error => { Object.assign(window, { chunkFailure: String(error) }) }) }) }, missingChunk)
          } else {
            await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update())
          }
          await until(async () => await version(page) === after.version, 'replacement worker')
          await page.waitForTimeout(1000)
          assert.equal(await page.evaluate(() => Reflect.get(window, 'documentInstance')), initial)
          assert.equal(await marker(page), before.version)
          result.heldUntilSettled = true
          releaseWrites.splice(0).forEach(release => release())
          await until(async () => await marker(page).catch(() => null) === after.version, 'safe reload after settlement')
          await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor()
          result.reloadedAfterSettlement = true
        }
        await until(async () => await version(page) === after.version, 'after worker')
        await context.setOffline(true)
        await page.goto(`${origin}/sign-in`)
        await page.getByRole('textbox', { name: 'Email', exact: true }).waitFor()
        result.offlineSignIn = true
        if (scenario !== 'missing-chunk') assert.deepEqual(result.errors, [])
        result.passed = true
      } catch (error) {
        result.failure = String(error)
        result.workerState = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration()
          const entries = []
          for (const name of await caches.keys()) {
            const cache = await caches.open(name)
            entries.push({ name, urls: (await cache.keys()).map(request => new URL(request.url).pathname) })
          }
          return { active: registration?.active?.state, waiting: registration?.waiting?.state,
            installing: registration?.installing?.state, entries, events: Reflect.get(window, 'workerEvents'),
            controller: navigator.serviceWorker.controller?.state }
        }).catch(() => null)
      }
      finally {
        holdImage = false
        releaseWrites.splice(0).forEach(release => release())
        releaseImages.splice(0).forEach(release => release())
        await context.close()
        await writeFile(`${directory}/results.json`, JSON.stringify({ before, after, results, requests }, null, 2))
        console.log(engine, scenario, result.failure ?? 'passed')
      }
    }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
assert(results.every(result => result.passed), JSON.stringify(results))
