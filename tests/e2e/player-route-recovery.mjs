import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'
import { pathToFileURL } from 'node:url'

export async function verifyPlayerRouteRecovery() {
  const fixture = JSON.parse(await readFile(process.env.PLAYER_ROUTE_FIXTURE, 'utf8'))
  const current = process.env.PLAYER_ROUTE_URL
  const previous = process.env.PLAYER_ROUTE_PREVIOUS_URL
  const report = []
  const engines = { chromium, webkit }
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

  async function open(engine, base, worker = false) {
    const browser = await engine.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: worker ? 'allow' : 'block' })
    await context.addInitScript(({ session }) => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), fixture)
    const page = await context.newPage()
    if (process.env.PLAYER_ROUTE_PUBLIC_KEY) {
      await page.route('http://127.0.0.1:55471/**', route => route.continue({ headers: { ...route.request().headers(), apikey: process.env.PLAYER_ROUTE_PUBLIC_KEY } }))
    }
    await page.goto(`${base}/players`)
    const row = page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true })
    await row.waitFor({ state: 'visible', timeout: 30000 })
    return { browser, page, row }
  }

  async function firstTap(name, engine, base, before = false) {
    const { browser, page, row } = await open(engine, base)
    try {
      const chunks = []
      page.on('request', request => {
        if (request.url().includes('/_expo/static/js/web/[id]-') || request.url().includes('/_expo/static/js/web/%5Bid%5D-')) chunks.push(request.url())
      })
      if (process.env.PLAYER_ROUTE_SLOW_READS !== '0') {
      await page.route(/\/_expo\/static\/js\/web\/(?:\[id\]|%5Bid%5D)-/, async route => { await pause(1500); await route.continue() })
      await page.route(/\/rest\/v1\/(?:player_game_stats|roster_transactions|players)(?:\?|$)/, async route => { await pause(2000); await route.fallback() })
      await page.route(/\/rest\/v1\/rpc\/(?:get_league_projection_rows|get_player_roster_context)/, async route => { await pause(2000); await route.fallback() })
      }
      const start = performance.now()
      await row.click()
      await page.getByTestId('player-position-line').waitFor({ state: 'visible', timeout: 15000 })
      const headerMs = Math.round(performance.now() - start)
      await page.getByLabel('24.0 PTS', { exact: true }).waitFor({ state: 'visible', timeout: 15000 })
      const averagesMs = Math.round(performance.now() - start)
      if (!before) {
        assert.equal(chunks.length, 0, 'Player navigation still downloads a route chunk')
        assert.ok(headerMs < 1000, `Player header took ${headerMs}ms`)
        assert.ok(averagesMs < 2000, `Averages waited for the game log: ${averagesMs}ms`)
        await page.screenshot({ path: `${process.env.PLAYER_ROUTE_ARTIFACT_DIR}/${name}-player.png` })
        await page.getByTestId('player-position-line').screenshot({ path: `${process.env.PLAYER_ROUTE_ARTIFACT_DIR}/${name}-header.png` })
      }
      report.push({ engine: name, build: before ? 'before' : 'after', headerMs, averagesMs, routeRequests: chunks.length })
      console.log(JSON.stringify(report.at(-1)))
    } finally { await browser.close() }
  }

  async function recovery(name, engine, failure) {
    const { browser, page } = await open(engine, current, failure === 'worker')
    try {
      if (failure === 'worker') {
        await page.evaluate(async () => {
          await navigator.serviceWorker.ready
          if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
        })
      }
      const missing = `${current}/_expo/static/js/web/stale-player.js`
      const response = await page.request.get(missing)
      assert.equal(response.status(), 404)
      assert.equal(response.headers()['cache-control'], 'no-store')
      assert.ok(!response.headers()['content-type'].includes('text/html'))
      if (failure === 'html') await page.route('**/stale-player.js', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Old rewrite</title>' }))
      if (failure === 'network') await page.route('**/stale-player.js', route => route.abort())
      let navigations = 0
      page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations += 1 })
      await page.evaluate(() => { Reflect.set(window, '__pancakePwaHolds', new Set(['unsent-draft'])) })
      await page.evaluate(src => { const script = document.createElement('script'); script.src = src; document.head.append(script) }, missing)
      await page.locator('#pancake-update-notice').waitFor({ state: 'visible' })
      assert.match(await page.locator('#pancake-update-notice').textContent(), /Finish your current work/)
      assert.equal(navigations, 0, 'Recovery discarded unsent work')
      await Promise.all([
        page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 10000 }),
        page.evaluate(() => { Reflect.get(window, '__pancakePwaHolds').clear(); window.dispatchEvent(new Event('pancake-pwa-hold-change')) }),
      ])
      await page.getByRole('button', { name: `Open ${fixture.player.display_name}`, exact: true }).waitFor({ state: 'visible' })
      assert.equal(navigations, 1)
      report.push({ engine: name, failure, recovered: true, heldDraft: true, navigations })
      console.log(JSON.stringify(report.at(-1)))
    } finally { await browser.close() }
  }

  try {
    for (const [name, engine] of Object.entries(engines)) {
      if (previous) await firstTap(name, engine, previous, true)
      await firstTap(name, engine, current)
      if (process.env.PLAYER_ROUTE_ONLY_TIMING !== '1') for (const failure of ['404', 'html', 'network', 'worker']) await recovery(name, engine, failure)
    }
  } finally {
    await writeFile(`${process.env.PLAYER_ROUTE_ARTIFACT_DIR}/player-route-report.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyPlayerRouteRecovery()
