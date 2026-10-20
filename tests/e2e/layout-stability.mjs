import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { WEB_TARGETS, openWebTarget, pressWebControl } from './web-targets-browser.mjs'
import { installLayoutStability, layoutShiftSessionScore } from './web-targets-geometry.mjs'
import { prepareSweepFixtures, sweepSurfaces } from './layout-stability-fixtures.mjs'
import { saveSweepReport, sweepFailures } from './layout-stability-report.mjs'
import { isSweepEndpoint, requireSweepLocal, requireSweepStack, resolveSweepPorts, stackEnvironment, sweepFetchGuardScript } from './layout-stability-ports.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const TARGETS = WEB_TARGETS.filter((target) => target.mobile ? target.standalone : target.engine === 'chromium' || target.viewport.width === 1440)
const SCENARIOS = ['cold', 'refresh', 'tab-return', 'reconnect', 'in-app', 'back-forward']
const PROFILES = { seeded: { min: 250, max: 900 }, slow: { min: 1400, max: 1600 }, none: { min: 0, max: 0 } }
const HELP = `Usage: node tests/e2e/layout-stability.mjs [options]
  --api-port=56121                       Explicit port; otherwise stack env or default
  --db-port=56122                        Exact PostgreSQL port for seed validation
  --frontend-port=56190                  Exact HTTP frontend port
  --frontend-url=URL                     Stack env URL or HTTP loopback on frontend port
  --stack-env=/absolute/local-stack.env   Generated local keys; never a production .env
  --state=/absolute/e2e-state.json        Seed output; defaults to tests/e2e-state.json
  --targets=all                          Comma-separated exact target IDs
  --scenarios=all                        ${SCENARIOS.join(',')}
  --surfaces=all                         Comma-separated IDs; --list prints all
  --latency-profile=seeded,slow           Seeded 250–900 ms; slow 1400–1600 ms; none
  --seed=493                             Deterministic hash of method, path, occurrence
  --label=before
  --output-dir=/absolute/evidence/sweep/before  Must be outside the checkout
  --build-sha=SHA                        Assert release-provenance.json commitSha
  --observe-ms=2500                      Minimum capture window after each action
  --settle-timeout-ms=15000              API quiet + 500 ms layout stability deadline
  --notice-navigation                   Dedicated empty Home navigation regression
  --cycles=10                           At least ten cycles per target
  --workers=1                           One to four simultaneous browser groups
  --self-test                           Browser probe; no stack or app needed
  --list                                Print targets, surfaces, scenarios
  --help

Cold contexts contain only a local auth session and selected-league identity.
Content storage, service workers, and caches start empty. Refresh reuses them.
API and frontend guards require HTTP loopback on their exact configured ports.
Ports use CLI flags, then stack env port values or URLs, then 56121/56122/56190.
Service workers remain enabled. API requests receive page.route latency.
Controlled pages use a fetch delay fallback because worker fetches bypass page.route.
Every cell records executed actions, support, raw frames, errors, and request delays.
Unavailable navigation controls produce NOT_RUN cells with a reason.
Exit 0: all measured cells pass. Exit 1: detected failure. Exit 2: incomplete run.
Targets: ${TARGETS.map((target) => target.id).join(', ')}
`

const parseArgs = () => {
  const options = {}
  for (const arg of process.argv.slice(2)) {
    assert.ok(arg.startsWith('--'), `Invalid argument ${arg}`)
    const split = arg.indexOf('=')
    options[arg.slice(2, split < 0 ? undefined : split)] = split < 0 ? true : arg.slice(split + 1)
  }
  const known = new Set(['api-port', 'db-port', 'frontend-port', 'frontend-url', 'stack-env', 'state', 'targets', 'scenarios', 'surfaces', 'latency-profile', 'seed', 'label', 'output-dir', 'build-sha', 'observe-ms', 'settle-timeout-ms', 'notice-navigation', 'cycles', 'workers', 'self-test', 'help', 'list'])
  for (const key of Object.keys(options)) assert.ok(known.has(key), `Unknown option --${key}`)
  return options
}
const choose = (items, value, key = (item) => item) => {
  if (!value || value === 'all') return items
  const names = value.split(',')
  for (const name of names) assert.ok(items.some((item) => key(item) === name), `Unknown selection ${name}`)
  return items.filter((item) => names.includes(key(item)))
}
const read = async (page) => {
  const capture = await page.evaluate(() => Reflect.get(window, '__layoutStability')?.read())
  if (capture?.support.cls === 'supported') capture.metrics.cls = layoutShiftSessionScore(capture.shifts)
  return capture
}
const reset = (page) => page.evaluate(() => Reflect.get(window, '__layoutStability').reset())
const mark = (page, name) => page.evaluate((name) => Reflect.get(window, '__layoutStability').mark(name), name)
const errorText = (error) => error instanceof Error ? error.message : String(error)
const routeMatches = (url, route) => {
  const expected = new URL(route, url.href)
  return url.pathname === expected.pathname && [...expected.searchParams].every(([key, value]) => url.searchParams.get(key) === value)
}

async function attachLatency(page, profile, seed, ports) {
  const log = []
  const counts = new Map()
  const pending = new Set()
  let delaying = 0
  let changed = Date.now()
  const delay = async (urlString, method, via) => {
    const url = requireSweepLocal(urlString, ports.api)
    const normalized = `${url.pathname}${url.search}`.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<fixture-id>')
    const key = `${method} ${normalized}`
    const occurrence = (counts.get(key) ?? 0) + 1
    counts.set(key, occurrence)
    const digest = createHash('sha256').update(`${seed}:${key}:${occurrence}`).digest().readUInt32LE()
    const ms = profile.min + digest % (profile.max - profile.min + 1)
    log.push({ path: url.pathname, method, occurrence, delayMs: ms, via, at: Date.now() })
    delaying++
    try { await new Promise((resolve) => setTimeout(resolve, ms)) }
    finally { delaying--; changed = Date.now() }
  }
  await page.exposeFunction('__layoutApiDelay', ({ url, method }) => delay(url, method, 'fetch-before-service-worker'))
  await page.addInitScript({ content: sweepFetchGuardScript(ports) })
  page.on('request', (request) => {
    if (/\/(rest|auth|functions|storage)\/v1\//.test(request.url())) { pending.add(request); changed = Date.now() }
  })
  const done = (request) => { if (pending.delete(request)) changed = Date.now() }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) { pending.clear(); changed = Date.now() } })
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiRequest = /\/(rest|auth|functions|storage)\/v1\//.test(url.pathname)
    if (!isSweepEndpoint(url.href, ports.api) && (apiRequest || !isSweepEndpoint(url.href, ports.frontend))) {
      log.push({ path: url.pathname, blockedExternal: true })
      await route.abort('blockedbyclient')
      return
    }
    if (apiRequest && !request.headers()['x-client-info']?.includes('layout-stability-delayed')) {
      await delay(url.href, request.method(), 'page.route')
    }
    await route.continue().catch(() => {})
  })
  return { log, pending, quiet: () => delaying === 0 && pending.size === 0 && Date.now() - changed >= 500 }
}

async function observe(page, network, options) {
  const started = Date.now()
  await page.waitForTimeout(options.observe)
  while (Date.now() - started < options.timeout) {
    const capture = await read(page)
    if (network.quiet() && capture?.metrics.stableLayoutMs !== null && capture?.metrics.firstContentMs !== null && await expectedContentVisible(page, options.expected)) return { ...capture, observation: { apiQuiet: true, waitedMs: Date.now() - started, expectedContentVisible: true } }
    await page.waitForTimeout(100)
  }
  return { ...await read(page), observation: { apiQuiet: network.quiet(), waitedMs: Date.now() - started, expectedContentVisible: await expectedContentVisible(page, options.expected), pendingRequests: [...network.pending].map((request) => new URL(request.url()).pathname) } }
}

async function expectedContentVisible(page, expected) {
  if (!expected) return true
  const main = page.locator('[role="main"]').first()
  const content = await main.count() ? main : page.locator('body')
  for (const match of await content.getByText(expected, { exact: false }).all()) if (await match.isVisible()) return true
  return false
}

async function makeClient(target, dir, surface, fixture, env, profile, seed, frontend, ports) {
  await mkdir(dir, { recursive: true })
  const storage = surface.auth && fixture ? [{ name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(await fixture.sessionForBrowser()) },
    { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: surface.empty ? fixture.empty.members[0].id : fixture.me.id }) }] : []
  const client = await openWebTarget(target, dir, { reducedMotion: 'no-preference', storageState: { cookies: [], origins: [{ origin: frontend, localStorage: storage }] } })
  client.page.setDefaultTimeout(8000)
  client.page.setDefaultNavigationTimeout(20000)
  await client.context.addInitScript(installLayoutStability)
  client.network = await attachLatency(client.page, profile, seed, ports)
  client.errors = []
  client.page.on('pageerror', (error) => client.errors.push(errorText(error)))
  return client
}

async function clickRoute(client, route) {
  const { page } = client
  const labels = { '/': /^(Home|Matchup)$/, '/players': /^Players$/, '/roster': /^Roster$/, '/dynasty': /^Dynasty$/, '/trades': /^Trades(?:,.*)?$/, '/league': /^League$/, '/profile': /^Profile(?: & settings)?$/, '/draft': /^Draft Room$/, '/bracket': /^Playoffs$/, '/commissioner-settings': /^Commissioner$/ }
  const pressNamed = async () => {
    if (!labels[route]) return false
    for (const role of ['link', 'button']) for (const control of await page.getByRole(role, { name: labels[route] }).all()) {
      if (await control.isVisible()) {
        await pressWebControl(client.target, control)
        await page.waitForURL((url) => routeMatches(url, route))
        return true
      }
    }
    return false
  }
  if (await pressNamed()) return true
  const links = page.locator('a[href]')
  for (const link of await links.all()) {
    const href = new URL(await link.getAttribute('href'), page.url())
    if (routeMatches(href, route) && await link.isVisible()) {
      await pressWebControl(client.target, link)
      await page.waitForURL((url) => routeMatches(url, route))
      return true
    }
  }
  if (!labels[route]) return false
  const menu = page.getByRole('button', { name: 'Open menu', exact: true })
  if (await menu.isVisible()) {
    await pressWebControl(client.target, menu)
    if (await pressNamed()) return true
    for (const link of await page.locator('a[href]').all()) {
      const href = new URL(await link.getAttribute('href'), page.url())
      if (routeMatches(href, route) && await link.isVisible()) {
        await pressWebControl(client.target, link)
        await page.waitForURL((url) => routeMatches(url, route))
        return true
      }
    }
    const close = page.getByLabel('Close', { exact: true }).first()
    if (await close.isVisible()) await pressWebControl(client.target, close)
  }
  return false
}

async function inAppReturn(client, surface, frontend) {
  const { page } = client
  if (surface.noAppLink) return { reason: surface.noAppLink }
  const origin = surface.origin ?? (surface.id === 'change-password' ? '/profile' : surface.id.startsWith('league-') || surface.id === 'commissioner-settings' || surface.id === 'bracket' ? '/league' : surface.id === 'rankings' || surface.id === 'news' ? '/players' : surface.route === '/' ? '/players' : '/')
  if (!await clickRoute(client, origin)) await page.goto(new URL(origin, frontend).href)
  await observe(page, client.network, { observe: 800, timeout: 8000 })
  await reset(page)
  if (await clickRoute(client, surface.route)) return { action: `Visible app link from ${origin} to ${surface.route}` }
  if (surface.id === 'lineup') {
    const auto = page.getByRole('button', { name: /Set lineup automatically|Open auto-set lineup options/ }).first()
    if (await auto.isVisible()) {
      await pressWebControl(client.target, auto)
      await pressWebControl(client.target, page.getByRole('button', { name: 'Edit lineup manually', exact: true }))
      return { action: 'Roster auto-set options, Edit lineup manually' }
    }
  }
  if (surface.control || surface.textControl) {
    const control = surface.textControl ? page.getByText(surface.textControl, { exact: true }).first() : page.getByRole('button', { name: surface.control, exact: true })
    if (await control.isVisible()) {
      await pressWebControl(client.target, control)
      if (surface.followControl) await pressWebControl(client.target, page.getByRole('button', { name: surface.followControl, exact: true }))
      await page.waitForURL((url) => routeMatches(url, surface.route))
      return { action: `Visible control: ${surface.control ?? surface.textControl}` }
    }
  }
  const tabNames = { rankings: 'Rankings', news: 'News', 'league-results': 'Standings', 'league-history': 'Activity', 'league-draftBoard': 'Draft Board', 'league-auctions': 'Auctions', 'league-mockRooms': 'Mock Rooms', 'league-settings': 'Settings' }
  if (tabNames[surface.id]) {
    const tab = page.getByRole('tab', { name: tabNames[surface.id], exact: true })
    if (await tab.isVisible()) {
      await pressWebControl(client.target, tab)
      await page.waitForFunction((label) => [...document.querySelectorAll('[role="tab"]')].some((node) => node.textContent.includes(label) && node.getAttribute('aria-selected') === 'true'), tabNames[surface.id])
      return { action: `Visible ${tabNames[surface.id]} tab`, selectedTab: tabNames[surface.id] }
    }
  }
  return { reason: `No visible app link to ${surface.route} from ${origin}; no synthetic router navigation substituted` }
}

async function runScenario(client, surface, scenario, options) {
  const { page, context, network } = client
  const observation = { ...options, expected: surface.expected }
  const url = new URL(surface.route, options.frontend).href
  let navigationEvidence = null
  if (scenario === 'cold') {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  } else {
    if (page.url() !== url) { await page.goto(url); await observe(page, network, observation) }
    await reset(page)
    if (scenario === 'refresh') {
      const cacheBefore = await page.evaluate(async () => ({ localStorageKeys: Object.keys(localStorage).filter((key) => !key.includes('auth-token')), serviceWorkerControlled: !!navigator.serviceWorker?.controller, caches: await caches.keys() }))
      client.cacheBefore = cacheBefore
      await page.reload({ waitUntil: 'domcontentloaded' })
    }
    if (scenario === 'tab-return') {
      const other = await context.newPage()
      await other.goto('about:blank')
      await other.bringToFront()
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('blur'))
      })
      await mark(page, 'background-tab-and-injected-hidden-blur')
      await page.waitForTimeout(500)
      await page.bringToFront()
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
      })
      await other.close()
      await mark(page, 'foreground-tab-and-injected-visible-focus')
    }
    if (scenario === 'reconnect') {
      await context.setOffline(true)
      await mark(page, 'offline-start')
      await page.waitForTimeout(5100)
      await context.setOffline(false)
      await mark(page, 'online-after-5100ms')
    }
    if (scenario === 'in-app') {
      const navigation = await inAppReturn(client, surface, options.frontend)
      if (navigation.reason) return navigation
      navigationEvidence = navigation
      await mark(page, navigation.action)
    }
    if (scenario === 'back-forward') {
      const alternative = surface.route === '/' ? '/players' : '/'
      if (!await clickRoute(client, alternative)) await page.goto(new URL(alternative, options.frontend).href)
      await page.waitForTimeout(100)
      await page.goBack({ waitUntil: 'domcontentloaded' })
      const backward = await observe(page, network, observation)
      await page.goForward({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(100)
      await page.goBack({ waitUntil: 'domcontentloaded' })
      const returned = await observe(page, network, observation)
      return { capture: returned, additionalCaptures: { backward }, action: 'App navigation away when available, browser back, forward, and back to surface' }
    }
  }
  return { capture: await observe(page, network, observation), navigation: navigationEvidence }
}

async function probePortGuards(client, options) {
  const api = `http://127.0.0.1:${options.ports.api}/rest/v1/layout-port-probe`
  let intercepted = 0
  await client.page.route(`${options.frontend}/layout-port-probe`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Port guard probe</p>' }))
  await client.page.route(api, (route) => {
    intercepted++
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"accepted":true}' })
  })
  await client.page.goto(`${options.frontend}/layout-port-probe`)
  const accepted = await client.page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).json(), api)
  assert.equal(accepted.accepted, true, 'Configured API port was rejected')
  assert.equal(intercepted, 1, 'API probe must be intercepted without reaching a stack')
  const rejected = [
    api.replace(`:${options.ports.api}/`, options.ports.api === '56121' ? ':56120/' : ':56121/'),
    api.replace('127.0.0.1', 'example.invalid'),
    `${api}?project=ceeytbfmwsnzalxlkalc`,
    api.replace('http:', 'https:'),
  ]
  for (const url of rejected) {
    const error = await client.page.evaluate(async (url) => {
      try { await fetch(url, { method: 'POST' }); return null }
      catch (error) { return error.message }
    }, url)
    assert.equal(error, 'Layout sweep refuses a non-lane API request', `API guard did not reject ${url}`)
  }
  return { ports: options.ports, accepted: intercepted, refused: rejected.length, networkWrites: 0 }
}

async function selfTest(targets, options) {
  const results = []
  for (const target of targets) {
    const dir = path.join(options.output, `self-test-${target.id}`)
    const client = await makeClient(target, dir, { auth: false }, null, {}, PROFILES.none, 0, options.frontend, options.ports)
    try {
      const portGuards = await probePortGuards(client, options)
      await client.page.route(`${options.frontend}/layout-cover-probe`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="pancake-boot-shell" data-visible="1" style="position:fixed;inset:0;z-index:999;background:white">Boot chrome</div><main role="main"><h1>Covered content</h1><p id="covered-loading">Loading behind the opaque shell…</p></main><script>setTimeout(()=>document.querySelector("main").style.visibility="hidden",100);setTimeout(()=>{document.querySelector("main").style.visibility="visible";document.querySelector("#covered-loading").remove()},400);setTimeout(()=>document.querySelector("#pancake-boot-shell").remove(),600)</script>' }))
      await client.page.goto(`${options.frontend}/layout-cover-probe`)
      await client.page.waitForTimeout(1200)
      const covered = await read(client.page)
      await writeFile(path.join(dir, 'covered-probe.json'), JSON.stringify(covered))
      assert.equal(covered.metrics.loadingDurationMs, 0, 'Opaque boot shell content reports visible loading')
      assert.equal(covered.metrics.blankFrames, 0, 'Opaque boot shell content reports blank frames')
      assert.equal(covered.metrics.reappearances, 0, 'Opaque boot shell content reports reappearance')
      assert.ok(covered.frames.some((frame) => frame.bootCovered), 'Boot coverage was not sampled')
      await client.page.route(`${options.frontend}/layout-ready-probe`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main role="main"><h1>Stable header</h1></main><script>setTimeout(()=>{const row=document.createElement("p");row.textContent="Delayed seeded content";document.querySelector("main").append(row)},1200)</script>' }))
      await client.page.goto(`${options.frontend}/layout-ready-probe`)
      const ready = await observe(client.page, client.network, { observe: 100, timeout: 4000, expected: 'Delayed seeded content' })
      await writeFile(path.join(dir, 'readiness-probe.json'), JSON.stringify(ready))
      assert.ok(await expectedContentVisible(client.page, 'Delayed seeded content'), 'Observation ended before seeded content arrived')
      await client.page.route(`${options.frontend}/layout-probe`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><main role="main"><h1 id="heading">Stable content</h1><p id="row">Already painted row</p><section><div><div><div><div><div><div><div><div><p>EP</p></div></div></div></div></div></div></div></div></section><section><div><div><div><div><div><div><div><div><p>EP</p></div></div></div></div></div></div></div></div></section><section role="status" aria-busy="true" aria-label="Loading support data"><p>Saved results</p></section></main>' }))
      await client.page.goto(`${options.frontend}/layout-probe`)
      await client.page.waitForTimeout(700)
      const control = await read(client.page)
      await writeFile(path.join(dir, 'control.json'), JSON.stringify(control, null, 2))
      await client.page.screenshot({ path: path.join(dir, 'control.png') })
      assert.equal(control.metrics.maxVerticalPx, 0, 'Stable control reports displacement')
      assert.equal(control.metrics.loadingDurationMs, 0, 'Stable control reports loading')
      assert.equal(control.metrics.spinnerDurationMs, 0, 'A busy-region label is not a visible spinner')
      assert.equal(control.metrics.blankFrames, 0, 'Stable control reports blank frames')
      if (control.support.firstPaint === 'paint-api') {
        assert.notEqual(control.firstContentfulPaintAt, null, 'Supported Paint Timing did not produce FCP')
        assert.ok(control.began + control.metrics.firstContentMs >= control.firstContentfulPaintAt, 'Content was tracked before FCP')
      }
      await reset(client.page)
      await client.page.evaluate(() => {
        setTimeout(() => {
          const banner = document.createElement('div')
          banner.id = 'probe-banner'
          banner.style.height = '90px'
          banner.textContent = 'Loading injected probe…'
          const spinner = document.createElement('div')
          spinner.setAttribute('role', 'progressbar')
          spinner.style.cssText = 'height:20px;width:20px;background:red'
          banner.append(spinner)
          document.querySelector('main').prepend(banner)
        }, 500)
        setTimeout(() => document.querySelector('#probe-banner').remove(), 1100)
        setTimeout(() => { document.querySelector('main').style.visibility = 'hidden' }, 1400)
        setTimeout(() => { document.querySelector('main').style.visibility = 'visible' }, 1650)
      })
      await client.page.waitForTimeout(2300)
      const capture = await read(client.page)
      const m = capture.metrics
      assert.ok(m.maxVerticalPx >= 80, `Shift missed: ${JSON.stringify(m)}`)
      assert.ok(m.loadingDurationMs >= 400, 'Loading text missed')
      assert.ok(m.spinnerDurationMs >= 400, 'Spinner missed')
      assert.ok(m.blankFrames > 0, 'Blank frames missed')
      assert.ok(m.reappearances > 0, 'Reappearance missed')
      if (target.engine === 'webkit') assert.equal(m.cls, 'unsupported')
      else assert.ok(m.cls > 0, 'Chromium CLS missed')
      await writeFile(path.join(dir, 'probe.json'), JSON.stringify(capture, null, 2))
      await client.page.screenshot({ path: path.join(dir, 'probe.png') })
      results.push({ target: target.id, browserVersion: client.browser.version(), status: 'PASS', portGuards, covered: covered.metrics, readiness: ready.observation, control: control.metrics, metrics: m })
    } finally { await client.context.close(); await client.browser.close() }
  }
  await writeFile(path.join(options.output, 'self-test.json'), JSON.stringify(results, null, 2))
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
}

async function noticeNavigation(target, fixture, env, profile, options, report) {
  const surface = sweepSurfaces(fixture).find((row) => row.empty)
  const dir = path.join(options.output, 'notice-navigation', target.id, options.profile)
  const client = await makeClient(target, dir, surface, fixture, env, profile, options.seed, options.frontend, options.ports)
  client.target = target
  try {
    await client.page.goto(options.frontend)
    const initial = await observe(client.page, client.network, options)
    await writeFile(path.join(dir, 'initial.json'), JSON.stringify(initial))
    await client.page.screenshot({ path: path.join(dir, 'initial.png') })
    for (let cycle = 0; cycle < options.cycles; cycle++) {
      const started = Date.now()
      for (const navigation of ['app', 'back', 'forward']) {
        await reset(client.page)
        if (navigation === 'app') {
          assert.ok(await clickRoute(client, '/players'), 'Players navigation unavailable')
          await client.page.waitForTimeout(100)
          assert.ok(await clickRoute(client, '/'), 'Home navigation unavailable')
        } else if (navigation === 'back') {
          assert.ok(await clickRoute(client, '/players'), 'Players navigation unavailable')
          await client.page.waitForTimeout(100)
          await client.page.goBack({ waitUntil: 'domcontentloaded' })
        } else {
          await client.page.goBack({ waitUntil: 'domcontentloaded' })
          await client.page.goForward({ waitUntil: 'domcontentloaded' })
        }
        await client.page.waitForURL((url) => url.pathname === '/')
        const capture = await observe(client.page, client.network, { ...options, observe: 650, timeout: 4000 })
        const failures = [!capture.metrics.noticePresent && 'notice absent on Home', capture.metrics.blankFrames > 0 && `${capture.metrics.blankFrames} blank frames`, capture.metrics.noticeMissingFrames > 0 && `${capture.metrics.noticeMissingFrames} notice-missing frames`].filter(Boolean)
        const evidence = path.join(dir, `${cycle + 1}-${navigation}`)
        await writeFile(`${evidence}.json`, JSON.stringify(capture))
        if (failures.length) await client.page.screenshot({ path: `${evidence}.png` })
        const row = report.cells.find((row) => row.target === target.id && row.latencyProfile === options.profile && row.scenario === `notice-${cycle + 1}-${navigation}`)
        Object.assign(row, { surface: 'home-empty', target: target.id, engine: target.engine, browserVersion: client.browser.version(), viewport: target.viewport, scenario: `notice-${cycle + 1}-${navigation}`, latencyProfile: options.profile, status: failures.length ? 'FAIL' : 'PASS', failures, metrics: capture.metrics, support: capture.support, initialNoticePresent: initial.metrics.noticePresent, video: path.relative(options.output, await client.page.video().path()), evidence: path.relative(options.output, `${evidence}.json`), cycleElapsedMs: Date.now() - started })
        delete row.reason
        await saveSweepReport(report, options.output, 'notice-navigation')
      }
      assert.ok(Date.now() - started < 30000, 'Notice cycle exceeds 30 seconds')
      process.stdout.write(`${target.id} notice cycle ${cycle + 1}: ${report.cells.filter((row) => row.target === target.id && row.latencyProfile === options.profile && row.scenario.startsWith(`notice-${cycle + 1}-`)).map((row) => row.status).join('/')}\n`)
    }
  } finally { await client.context.close(); await client.browser.close() }
}

async function main() {
  const args = parseArgs()
  if (args.help) { process.stdout.write(HELP); return }
  if (args.list) { process.stdout.write(JSON.stringify({ targets: TARGETS, scenarios: SCENARIOS, surfaces: sweepSurfaces() }, null, 2)); return }
  const env = await stackEnvironment(args['stack-env'])
  const ports = resolveSweepPorts(args, env)
  const options = { ports, frontend: args['frontend-url'] ?? env.E2E_FRONTEND_URL ?? `http://127.0.0.1:${ports.frontend}`, output: path.resolve(args['output-dir'] ?? '../evidence/sweep/before'), label: args.label ?? 'before', seed: Number(args.seed ?? 493), observe: Number(args['observe-ms'] ?? 2500), timeout: Number(args['settle-timeout-ms'] ?? 15000), cycles: Number(args.cycles ?? 10), workers: Number(args.workers ?? 1) }
  requireSweepLocal(options.frontend, ports.frontend)
  if (!args['self-test']) requireSweepStack(env, ports)
  assert.ok(!options.output.startsWith(`${process.cwd()}${path.sep}`) && options.output !== process.cwd(), 'Evidence must stay outside the checkout')
  assert.ok(options.cycles >= 10 && Number.isInteger(options.cycles), 'Notice mode requires at least ten cycles')
  assert.ok([1, 2, 3, 4].includes(options.workers), 'Use one to four browser workers')
  await mkdir(options.output, { recursive: true })
  const targets = choose(TARGETS, args.targets, (target) => target.id)
  if (args['self-test']) { await selfTest(targets, options); return }
  const scenarios = choose(SCENARIOS, args.scenarios)
  const profiles = choose(Object.keys(PROFILES), args['latency-profile'] ?? 'seeded,slow')
  const report = { label: options.label, generatedAt: new Date().toISOString(), command: process.argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' '), release: null, cells: [], options: { ...options, targets: targets.map((row) => row.id), scenarios, profiles }, limitations: ['Simulated standalone, no physical installation or OS suspension', 'page.route disables HTTP cache; service-worker CacheStorage remains enabled; controlled API fetches use an equivalent delay before reaching the worker', 'Geometry samples visible viewport elements, at most 200 candidates; offscreen content requires a separate scroll sweep', 'Cold storage contains only auth and selected-league identity', 'Routed non-loopback requests are blocked; controlled API fetches are guarded; worker-owned non-API requests can bypass routing'] }
  const hash = createHash('sha256')
  for (const name of ['layout-stability.mjs', 'layout-stability-ports.mjs', 'layout-stability-fixtures.mjs', 'layout-stability-report.mjs', 'web-targets-geometry.mjs', 'web-targets-browser.mjs', 'browser-smoke.mjs', 'soak-fixtures.mjs']) hash.update(await readFile(new URL(name, import.meta.url)))
  report.harness = { digest: hash.digest('hex'), nodeVersion: process.version }
  const surfaces = choose(sweepSurfaces(), args.surfaces, (surface) => surface.id)
  for (const target of targets) for (const profile of profiles) for (const surface of surfaces) for (const scenario of scenarios) report.cells.push({ surface: surface.id, target: target.id, engine: target.engine, viewport: target.viewport, scenario, latencyProfile: profile, status: 'NOT_RUN', reason: 'Run has not reached this cell' })
  if (args['notice-navigation']) report.cells = targets.flatMap((target) => profiles.flatMap((profile) => Array.from({ length: options.cycles }, (_, cycle) => ['app', 'back', 'forward'].map((navigation) => ({ surface: 'home-empty', target: target.id, engine: target.engine, viewport: target.viewport, scenario: `notice-${cycle + 1}-${navigation}`, latencyProfile: profile, status: 'NOT_RUN', reason: 'Run has not reached this cell' }))).flat()))
  const reportName = args['notice-navigation'] ? 'notice-navigation' : 'sweep'
  await saveSweepReport(report, options.output, reportName)
  try {
    const release = await fetch(`${options.frontend}/release-provenance.json`).then((response) => { assert.equal(response.status, 200); return response.json() })
    report.release = { commitSha: release.commitSha, bundleDigest: release.bundleDigest }
    if (args['build-sha']) assert.equal(release.commitSha, args['build-sha'])
    await runWithScenarioResourceOwner('layout stability', async (resourceOwner) => {
      const fixture = await prepareSweepFixtures({ env, ports, statePath: args.state ?? 'tests/e2e-state.json', resourceOwner })
      report.fixture = { leagueId: fixture.state.leagueId, emptyLeagueId: fixture.empty.league.id, seasonYear: fixture.season.season_year, currentWeek: fixture.currentWeek, seededRosterRows: 20 }
      const runGroup = async ({ target, profile }) => {
        if (args['notice-navigation']) { await noticeNavigation(target, fixture, env, PROFILES[profile], { ...options, profile }, report); return }
        for (const surface of choose(sweepSurfaces(fixture), args.surfaces, (surface) => surface.id)) {
          const dir = path.join(options.output, target.id, profile, surface.id)
          let client
          try {
            client = await makeClient(target, dir, surface, fixture, env, PROFILES[profile], options.seed, options.frontend, options.ports)
            client.target = target
            for (const scenario of scenarios) {
              const row = report.cells.find((row) => row.target === target.id && row.latencyProfile === profile && row.surface === surface.id && row.scenario === scenario)
              const requestStart = client.network.log.length
              const errorStart = client.errors.length
              row.browserVersion = client.browser.version()
              row.latencyRangeMs = PROFILES[profile]
              row.video = path.relative(options.output, await client.page.video().path())
              try {
                const result = await runScenario(client, surface, scenario, options)
                if (result.reason) { row.reason = result.reason; continue }
                const capture = result.capture
                row.metrics = capture.metrics
                row.support = capture.support
                row.failures = sweepFailures(capture, surface.empty)
                if (result.additionalCaptures) for (const [name, extra] of Object.entries(result.additionalCaptures)) row.failures.push(...sweepFailures(extra, surface.empty).map((failure) => `${name}: ${failure}`))
                if (surface.expected) {
                  if (!await expectedContentVisible(client.page, surface.expected)) row.failures.push(`Expected seeded content not visible: ${surface.expected}`)
                }
                row.actualRoute = new URL(client.page.url()).pathname + new URL(client.page.url()).search
                row.navigation = result.navigation
                const selectedPlayersTab = result.navigation?.selectedTab && ['rankings', 'news'].includes(surface.id) && new URL(client.page.url()).pathname === '/players'
                if (!selectedPlayersTab && !(surface.expectedRoutes ?? [surface.expectedRoute ?? surface.route]).some((route) => routeMatches(new URL(client.page.url()), route))) row.failures.push(`Unexpected route: ${row.actualRoute}`)
                row.errors = client.errors.slice(errorStart)
                if (row.errors.length) row.failures.push('Browser script error')
                row.status = row.failures.length ? 'FAIL' : 'PASS'
                delete row.reason
                row.cacheBefore = scenario === 'refresh' ? client.cacheBefore : undefined
                row.requests = client.network.log.slice(requestStart)
                row.evidence = path.relative(options.output, path.join(dir, `${scenario}.json`))
                await writeFile(path.join(options.output, row.evidence), JSON.stringify({ ...result, requests: row.requests, errors: row.errors }))
                if (row.status === 'FAIL') { row.screenshot = path.relative(options.output, path.join(dir, `${scenario}.png`)); await client.page.screenshot({ path: path.join(options.output, row.screenshot) }) }
              } catch (error) {
                row.status = 'FAIL'
                row.reason = errorText(error)
                const capture = await read(client.page).catch(() => null)
                if (capture) { row.metrics = capture.metrics; row.support = capture.support; await writeFile(path.join(dir, `${scenario}-error.json`), JSON.stringify(capture)) }
                await client.page.screenshot({ path: path.join(dir, `${scenario}-error.png`) }).catch(() => {})
              } finally {
                process.stdout.write(`${target.id} ${profile} ${surface.id} ${scenario}: ${row.status} ${row.reason ?? row.failures?.join('; ') ?? ''}\n`)
                await saveSweepReport(report, options.output)
              }
            }
          } catch (error) {
            for (const row of report.cells.filter((row) => row.target === target.id && row.latencyProfile === profile && row.surface === surface.id && row.status === 'NOT_RUN')) row.reason = `Browser setup failed: ${errorText(error)}`
          } finally { if (client) { await client.context.close(); await client.browser.close() } }
        }
      }
      const groups = targets.flatMap((target) => profiles.map((profile) => ({ target, profile })))
      let next = 0
      const workers = await Promise.allSettled(Array.from({ length: options.workers }, async () => {
        while (next < groups.length) await runGroup(groups[next++])
      }))
      const failed = workers.filter((result) => result.status === 'rejected')
      if (failed.length) throw new AggregateError(failed.map((result) => result.reason), failed.map((result) => errorText(result.reason)).join('; '))
    })
  } catch (error) {
    report.error = errorText(error)
    for (const row of report.cells.filter((row) => row.status === 'NOT_RUN')) row.reason = `Setup or run interrupted: ${report.error}`
  } finally { await saveSweepReport(report, options.output, reportName) }
  const counts = Object.fromEntries(['PASS', 'FAIL', 'NOT_RUN'].map((status) => [status, report.cells.filter((row) => row.status === status).length]))
  process.stdout.write(`${JSON.stringify({ counts, error: report.error ?? null, output: options.output })}\n`)
  process.exitCode = report.error || counts.NOT_RUN ? 2 : counts.FAIL ? 1 : 0
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${errorText(error)}\n`); process.exitCode = 2 })
