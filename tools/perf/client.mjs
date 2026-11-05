import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import WebSocket, { WebSocketServer } from 'ws'
import { cache, command, root, summary, sensitivity, note, digest } from './common.mjs'
import { port } from './database.mjs'

const EARLY_OBSERVER_SCRIPT = (await readFile(path.join(root, 'tests/e2e/pwa-paint-probe.mjs'), 'utf8')).match(/export const EARLY_OBSERVER_SCRIPT = `([\s\S]*?)`/)[1]

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
}

export async function buildClient(db) {
  const output = path.join(cache, 'web')
  note('Building production web assets.')
  const log = await command(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--output-dir', output], { env: { NODE_ENV: 'production', CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: db.values.ANON_KEY }, timeout: 300000 })
  await writeFile(path.join(cache, 'build.log'), log)
  const scripts = []
  for (const file of (await filesIn(output)).filter(file => file.endsWith('.js'))) scripts.push({ path: path.relative(output, file).replaceAll('\\', '/'), bytes: (await stat(file)).size, sha256: digest(await readFile(file)) })
  const routeInitialChunks = []
  for (const file of (await filesIn(output)).filter(file => file.endsWith('.html') && !path.relative(output, file).includes('('))) {
    const html = await readFile(file, 'utf8')
    const paths = [...html.matchAll(/<script[^>]*src="([^"?]+)[^"]*"/g)].map(match => match[1].replace(/^\//, ''))
    const initial = paths.map(value => scripts.find(script => script.path === value)).filter(Boolean)
    routeInitialChunks.push({ route: '/' + path.relative(output, file).replaceAll('\\', '/').replace(/index\.html$/, '').replace(/\.html$/, ''), bytes: initial.reduce((sum, script) => sum + script.bytes, 0), chunks: initial.map(script => script.path) })
  }
  return { output, scripts, routeInitialChunks, totalJsBytes: scripts.reduce((sum, item) => sum + item.bytes, 0) }
}

export async function serveClient(db, build) {
  const env = { ...process.env, DENO_DIR: path.join(cache, 'deno'), SUPABASE_URL: db.values.API_URL, SUPABASE_ANON_KEY: db.values.ANON_KEY, PANCAKE_SUPABASE_SECRET_KEY: db.values.SERVICE_ROLE_KEY, PERF_EDGE_PORT: String(port + 4) }
  const edge = spawn('deno', ['run', '--no-check', '--no-lock', '--node-modules-dir=manual', '--allow-env', '--allow-read', '--allow-net=127.0.0.1,localhost', 'tools/perf/edge.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let edgeLog = ''
  edge.stderr.on('data', data => { edgeLog += data })
  edge.stdout.on('data', data => { edgeLog += data })
  const sockets = new Set()
  const ws = new WebSocketServer({ noServer: true })
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://127.0.0.1:${port}`)
      if (/^\/(auth|rest|functions|storage)\//.test(url.pathname)) {
        const origin = url.pathname.startsWith('/functions/') ? `http://127.0.0.1:${port + 4}` : db.values.API_URL
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const headers = { ...request.headers }
        delete headers.host
        delete headers['content-length']
        delete headers['accept-encoding']
        const body = Buffer.concat(chunks)
        const upstream = await fetch(`${origin}${url.pathname}${url.search}`, { method: request.method, headers, ...(body.length ? { body } : {}), signal: AbortSignal.timeout(60000) })
        const outgoing = Object.fromEntries(upstream.headers)
        delete outgoing['content-encoding']
        delete outgoing['content-length']
        response.writeHead(upstream.status, outgoing)
        response.end(Buffer.from(await upstream.arrayBuffer()))
        return
      }
      let file = path.join(build.output, decodeURIComponent(url.pathname))
      if (!file.startsWith(build.output + path.sep) && file !== build.output) throw new Error('Invalid asset path')
      const details = await stat(file).catch(() => null)
      if (details?.isDirectory()) file = path.join(file, 'index.html')
      if (!await stat(file).catch(() => null)) file = path.join(build.output, `${url.pathname}.html`)
      if (!await stat(file).catch(() => null)) file = path.join(build.output, 'index.html')
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }
      response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable' })
      createReadStream(file).pipe(response)
    } catch (error) { response.writeHead(502); response.end(error.message) }
  })
  server.on('upgrade', (request, socket, head) => {
    const remote = new WebSocket(`${db.values.API_URL.replace('http', 'ws')}${request.url}`)
    ws.handleUpgrade(request, socket, head, local => {
      const pending = []
      remote.on('open', () => { for (const data of pending) remote.send(data) })
      local.on('message', data => remote.readyState === WebSocket.OPEN ? remote.send(data) : pending.push(data))
      remote.on('message', data => local.readyState === WebSocket.OPEN && local.send(data))
      remote.on('error', () => local.close())
      local.on('close', () => remote.close())
      remote.on('close', () => local.close())
      sockets.add(local); sockets.add(remote)
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const stop = async () => {
    for (const socket of sockets) socket.terminate()
    ws.close()
    await new Promise(resolve => server.close(resolve))
    edge.kill('SIGTERM')
    await writeFile(path.join(cache, 'edge.log'), edgeLog)
  }
  try {
    for (let i = 0; i < 120; i++) {
      if (edge.exitCode !== null) throw new Error(`Local Edge exited: ${edgeLog.slice(-3000)}`)
      try {
        const response = await fetch(`http://127.0.0.1:${port + 4}/functions/v1/api/health`)
        if (response.ok) return { stop }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Local Edge did not become ready: ${edgeLog.slice(-3000)}`)
  } catch (error) { await stop(); throw error }
}

export async function measureClient(seed, build, n = 5) {
  const browser = await chromium.launch({ headless: true, args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost'] })
  const errors = [], metrics = []
  let workDone = 0
  const base = `http://127.0.0.1:${port}`
  async function context() {
    const result = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: 'allow' })
    await result.addInitScript(EARLY_OBSERVER_SCRIPT)
    await result.addInitScript(() => {
      window.__perfLongTasks = []
      new PerformanceObserver(list => window.__perfLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true })
      function sample() {
        const body = document.body?.innerText ?? ''
        const populated = [...document.querySelectorAll('[aria-label^="Open Player "]')].some(element => { const box = element.getBoundingClientRect(); return box.height > 0 && box.top < innerHeight && box.bottom > 0 })
        const ready = location.pathname === '/' ? document.querySelector('[aria-current="date"]') && !body.includes('Matchup lineup loading') : document.querySelector('[aria-label="Open auto-set lineup options"]') && !body.includes('Loading roster')
        if (populated && ready) requestAnimationFrame(() => { window.__perfMeaningful = performance.now() })
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await result.addInitScript(({ session, memberId, userId }) => {
      if (!localStorage.getItem('sb-127-auth-token')) localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
      localStorage.setItem(`pancake:selected-league:v1:${userId}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: memberId }))
      const native = window.matchMedia.bind(window)
      window.matchMedia = query => {
        const value = native(query)
        if (query === '(display-mode: standalone)') Object.defineProperty(value, 'matches', { value: true })
        return value
      }
      Object.defineProperty(navigator, 'standalone', { value: true })
    }, { session: seed.session, memberId: seed.memberId, userId: seed.userId })
    return result
  }
  async function measure(ctx, screen, slowdown = false, capture = false) {
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await cdp.send('Performance.enable')
    const failures = []
    page.on('pageerror', error => failures.push(error.message))
    page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(base)) failures.push(`${response.status()} ${new URL(response.url()).pathname}`) })
    if (slowdown) await page.route('**/*', async route => {
      if (route.request().isNavigationRequest()) await new Promise(resolve => setTimeout(resolve, 2000))
      await route.continue()
    })
    const route = screen === 'Home' ? '/' : '/roster'
    try {
      await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForFunction(() => Number.isFinite(window.__perfMeaningful), null, { timeout: 60000 })
      const meaningfulPaintMs = await page.evaluate(() => window.__perfMeaningful)
      const performanceMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.filter(metric => ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'JSHeapUsedSize'].includes(metric.name)).map(metric => [metric.name, metric.value]))
      const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.initiatorType === 'script').map(e => ({ url: e.name, bytes: e.decodedBodySize, transferBytes: e.transferSize })))
      let target
      if (screen === 'Home') {
        target = page.locator('[aria-current="date"]')
        const old = await target.getAttribute('aria-label')
        target = page.locator('[role="button"][aria-label]:not([aria-current="date"])').filter({ hasText: /^[SMTWF]\s*\d+$/ }).first()
        const next = await target.getAttribute('aria-label')
        assert.notEqual(next, old)
        await target.click()
        await page.waitForFunction(label => document.querySelector('[aria-current="date"]')?.getAttribute('aria-label') === label, next)
      } else {
        await page.getByRole('button', { name: 'Open auto-set lineup options', exact: true }).click()
        await page.getByText('Edit lineup manually', { exact: true }).waitFor({ state: 'visible' })
      }
      const interactiveMs = await page.evaluate(() => performance.now())
      const entries = await page.evaluate(() => ({ resources: performance.getEntriesByType('resource').filter(e => e.initiatorType === 'script').map(e => ({ url: e.name, bytes: e.decodedBodySize, transferBytes: e.transferSize })), paints: window.__pancakePaintProbe?.entries ?? [], longTasks: window.__perfLongTasks, text: document.body.innerText.slice(0, 700), swControlled: Boolean(navigator.serviceWorker?.controller) }))
      assert.equal(failures.length, 0, failures.join('; '))
      assert.ok(entries.paints.some(p => p.name === 'first-contentful-paint'), 'Paint observer did not receive FCP')
      if (capture) await page.screenshot({ path: path.join(cache, `${screen.toLowerCase()}.png`), fullPage: true })
      workDone++
      return { meaningfulPaintMs, interactiveMs, performanceMetrics, ...entries, resources }
    } catch (error) {
      await writeFile(path.join(cache, `${screen.toLowerCase()}-failure.txt`), await page.locator('body').innerText().catch(() => 'No body'))
      await page.screenshot({ path: path.join(cache, `${screen.toLowerCase()}-failure.png`) }).catch(() => {})
      throw error
    } finally { await page.close() }
  }
  try {
    for (const screen of ['Home', 'Roster']) {
      const rows = { cold: [], warm: [] }
      for (let i = 0; i < n; i++) {
        const ctx = await context()
        try {
          rows.cold.push(await measure(ctx, screen, false, i === 0))
          rows.warm.push(await measure(ctx, screen))
        } catch (error) { errors.push(`${screen}: ${error.message}`) }
        finally { await ctx.close() }
      }
      for (const state of ['cold', 'warm']) if (rows[state].length) metrics.push({ screen, state, meaningfulPaintMs: summary(rows[state].map(row => row.meaningfulPaintMs)), interactiveMs: summary(rows[state].map(row => row.interactiveMs)), initialJsBytes: rows[state][0].resources.reduce((sum, resource) => sum + resource.bytes, 0), resources: rows[state][0].resources, samples: rows[state].map(({ meaningfulPaintMs, interactiveMs, swControlled, performanceMetrics, longTasks }) => ({ meaningfulPaintMs, interactiveMs, swControlled, performanceMetrics, longTasks })) })
    }
    const control = [], slow = []
    for (let i = 0; i < 5; i++) {
      for (const delayed of [false, true]) {
        const ctx = await context()
        try { (delayed ? slow : control).push((await measure(ctx, 'Roster', delayed)).meaningfulPaintMs) }
        catch (error) { errors.push(`Sensitivity: ${error.message}`) }
        finally { await ctx.close() }
      }
    }
    const proof = control.length === 5 && slow.length === 5 ? sensitivity(control, slow) : null
    if (!proof?.detected) errors.push('Client sensitivity failed')
    return { errorCount: errors.length, errors, workDone, totalJsBytes: build.totalJsBytes, scripts: build.scripts, routeInitialChunks: build.routeInitialChunks, metrics, sensitivity: proof, browser: await browser.version(), viewport: [390, 844], cpuThrottle: 4, definitions: { cold: 'New browser context with only local auth and selected membership; empty HTTP, service-worker, and app caches.', warm: 'Same context reopens the measured route after one completed cold visit.', meaningfulPaint: 'Second animation frame after route-specific controls and seeded player text are visible.', interactive: 'Elapsed navigation time through a successful day change (Home) or opening Auto-set (Roster). Includes automation response overhead; not Lighthouse TTI.', initialJs: 'Decoded bytes of scripts actually loaded for the initial route before the readiness interaction.' } }
  } finally { await browser.close() }
}
