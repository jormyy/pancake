import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { devices, webkit } from 'playwright'

const started = performance.now()
const origin = 'http://127.0.0.1:58080'
const run = process.argv.find(value => value.startsWith('--run='))?.split('=')[1] ?? '1'
assert.match(run, /^[a-zA-Z0-9-]+$/)
const evidence = path.resolve(process.env.PLAYERS_WEBKIT_EVIDENCE ?? `evidence/round4/run-${run}`)
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
for (const [url, port] of [[keys.API_URL, '58021'], [keys.DB_URL, '58022'], [origin, '58080']]) {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === port, 'Owned loopback targets required')
}
const sql = text => execFileSync('psql', [keys.DB_URL, '-X', '-At', '-v', 'ON_ERROR_STOP=1'], { input: text, encoding: 'utf8' }).trim()
const checked = async query => {
  const { data, error } = await query
  if (error) throw error
  return data
}
const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const savedYear = sql("SELECT pg_get_functiondef('public.current_season_year_et(timestamptz)'::regprocedure)")
const year = 2094
const league = randomUUID()
const season = randomUUID()
const games = [randomUUID(), randomUUID()]
const players = [randomUUID(), randomUUID(), randomUUID()]
const users = []
const report = {
  provenance: 'SYNTHETIC accounts, league, calendar, players, stat lines and scoring',
  engine: 'Playwright WebKit', run, browserVersion: '', executable: webkit.executablePath(),
  sourceSha: 'a018bc8188c265237810c7495dba36696802873c',
  surfaces: [], tasks: [], findings: [], consoleErrors: [], apiResponses: [], inputs: [], cleanup: [], seconds: 0,
  limits: ['No native iOS Safari, installed home-screen PWA, real device, Xcode or GUI Simulator',
    'Playwright WebKit does not emulate standalone display mode or nonzero safe-area env() values'],
}
let browser
let activePage
await mkdir(path.join(evidence, 'screenshots'), { recursive: true })
async function screenshot(page, name) {
  const file = path.join(evidence, 'screenshots', `${name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return path.relative(evidence, file)
}
async function geometry(page, name, locators = []) {
  const state = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.cssText = 'padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)'
    document.body.appendChild(probe)
    const style = getComputedStyle(probe)
    const safeArea = { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom) }
    probe.remove()
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      visualWidth: visualViewport?.width, safeArea }
  })
  assert.equal(state.width, name.startsWith('iphone-') ? 393 : 1440)
  assert.equal(state.height, name.startsWith('iphone-') ? 852 : 900)
  assert.equal(state.dpr, name.startsWith('iphone-') ? 3 : 1)
  assert.equal(state.scrollWidth, state.width, `${name}: document horizontal overflow`)
  assert.ok(state.bodyScrollWidth <= state.width, `${name}: body horizontal overflow`)
  const bounds = []
  for (const locator of locators) {
    await locator.scrollIntoViewIfNeeded()
    await locator.waitFor({ state: 'visible' })
    const box = await locator.boundingBox()
    assert.ok(box && box.x >= -1 && box.x + box.width <= state.width + 1 && box.y >= -1 && box.y + box.height <= state.height + 1, `${name}: target clipped`)
    const text = await locator.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const outer = element.getBoundingClientRect()
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      return { contentWidth: element.scrollWidth, boxWidth: element.clientWidth,
        textOutside: rects.some(rect => rect.left < outer.left - 1 || rect.right > outer.right + 1 || rect.top < outer.top - 1 || rect.bottom > outer.bottom + 1) }
    })
    assert.ok(!text.textOutside, `${name}: text clipped`)
    bounds.push({ text: (await locator.innerText()).slice(0, 180), box, ...text })
  }
  const image = await screenshot(page, name)
  report.surfaces.push({ name, ...state, bounds, screenshot: image })
}
async function task(page, viewport, name, work) {
  try { await work() }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const image = await screenshot(page, `${viewport}-${name}-failure`).catch(() => '')
    report.findings.push({ viewport, task: name, message, screenshot: image })
    await writeFile(path.join(evidence, `${viewport}-${name}-failure.txt`), await page.locator('body').innerText())
  }
}
async function mainSettings(page) {
  await page.goto(`${origin}/league?tab=settings`)
  await page.getByRole('button', { name: 'Open profile and settings', exact: true }).waitFor()
}
async function tap(locator, count) {
  await locator.scrollIntoViewIfNeeded()
  if (locator.page().viewportSize()?.width === 393) await locator.tap()
  else await locator.click()
  count.value++
}
async function notifications(page, viewport) {
  for (const kind of ['event', 'category', 'expand']) {
    await mainSettings(page)
    const taps = { value: 0 }
    await tap(page.getByRole('button', { name: 'Open profile and settings', exact: true }), taps)
    await tap(page.getByRole('button', { name: 'Notification settings', exact: true }), taps)
    const event = page.getByRole('switch', { name: 'Trades: New offer', exact: true })
    await event.waitFor()
    if (kind === 'event') {
      await tap(event, taps)
      await page.waitForFunction(() => document.querySelector('[aria-label="Trades: New offer"]')?.getAttribute('aria-checked') === 'false')
      await page.waitForTimeout(350)
      const stored = await checked(admin.from('notification_preferences').select('event_settings').eq('user_id', users[0].id).single())
      assert.equal(stored.event_settings.trade_offered, false)
      await geometry(page, `${viewport}-notification-event-off`, [event])
      await event.click()
    } else if (kind === 'category') {
      const category = page.getByRole('switch', { name: 'All trades notifications', exact: true })
      await tap(category, taps)
      await page.waitForFunction(() => document.querySelector('[aria-label="All trades notifications"]')?.getAttribute('aria-checked') === 'false')
      await page.waitForTimeout(350)
      const stored = await checked(admin.from('notification_preferences').select('category_settings,trade_enabled').eq('user_id', users[0].id).single())
      assert.equal(stored.category_settings.trade, false)
      assert.equal(stored.trade_enabled, false)
      await geometry(page, `${viewport}-notification-category-off`, [category])
      await category.click()
    } else {
      const category = page.getByRole('button', { name: 'League events', exact: true })
      assert.equal(await category.getAttribute('aria-expanded'), 'false')
      await geometry(page, `${viewport}-notification-collapsed`, [category])
      await tap(category, taps)
      assert.equal(await category.getAttribute('aria-expanded'), 'true')
      await geometry(page, `${viewport}-notification-expanded`, [category, page.getByRole('switch', { name: 'All league notifications', exact: true })])
    }
    report.tasks.push({ viewport, task: `notification-${kind}`, entry: '/league?tab=settings', taps: taps.value,
      tapsFromProfileSettings: taps.value - 1, persisted: kind !== 'expand' })
    await page.waitForTimeout(350)
  }
}
async function timer(page, viewport) {
  await mainSettings(page)
  const taps = { value: 0 }
  await tap(page.getByRole('tab', { name: 'Draft Board', exact: true }), taps)
  const seven = page.getByRole('radio', { name: '604800 seconds', exact: true })
  await tap(seven, taps)
  assert.equal(await seven.getAttribute('aria-checked'), 'true')
  await geometry(page, `${viewport}-timer-seven-days`, [seven])
  report.tasks.push({ viewport, task: 'timer-seven-days', entry: '/league?tab=settings', taps: taps.value })
  await tap(page.getByRole('button', { name: /^Start rookie draft,/ }), taps)
  const warning = page.getByText(/could run past opening night/)
  await page.waitForFunction(() => document.body.innerText.includes('could run past opening night') || (Array.isArray(Reflect.get(window, '__pancakeAlerts')) && Reflect.get(window, '__pancakeAlerts').length > 0))
  assert.ok(await warning.count(), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__pancakeAlerts'))))
  await page.waitForTimeout(500)
  await geometry(page, `${viewport}-timer-opening-warning`, [warning, page.getByRole('button', { name: 'Cancel', exact: true })])
  report.tasks.push({ viewport, task: 'timer-opening-warning', entry: '/league?tab=settings', taps: taps.value })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
}
async function playoffs(page, viewport) {
  await mainSettings(page)
  const taps = { value: 0 }
  await tap(page.getByRole('button', { name: 'Open commissioner settings', exact: true }), taps)
  const field = page.getByRole('textbox', { name: 'Playoff Start Week', exact: true })
  await tap(field, taps)
  await field.fill('22')
  const warning = page.getByRole('alert').filter({ hasText: /Playoffs need/ })
  await warning.waitFor()
  assert.match(await warning.innerText(), /Last available: week 20/)
  await geometry(page, `${viewport}-playoff-fit-warning`, [warning, field])
  report.tasks.push({ viewport, task: 'playoff-fit-warning', entry: '/league?tab=settings', taps: taps.value, textEdits: 1, saved: false })
}
async function playerList(page, viewport) {
  await checked(admin.from('player_game_stats').delete().eq('game_id', games[1]))
  await checked(admin.from('nba_games').update({ status: 'Scheduled' }).eq('id', games[1]))
  sql('SELECT public.refresh_player_search_caches();')
  await mainSettings(page)
  const taps = { value: 0 }
  await tap(page.getByRole('link', { name: 'Players', exact: true }), taps)
  const label = page.getByTestId('players-average-season')
  await page.waitForFunction(() => document.querySelector('[data-testid="players-average-season"]')?.textContent === '2092–93 avg')
  const first = page.getByText('Zeta Webkit', { exact: true })
  const second = page.getByText('Beta Webkit', { exact: true })
  await first.waitFor()
  let positions = await Promise.all([first.boundingBox(), second.boundingBox()])
  assert.ok(positions[0] && positions[1] && positions[0].y < positions[1].y, 'Preseason order follows league FP/game')
  if (viewport === 'desktop') await page.getByRole('button', { name: 'Sort by Fantasy points, descending', exact: true }).waitFor()
  assert.ok((await page.locator('body').innerText()).includes('120.0'))
  await geometry(page, `${viewport}-players-preseason`, [label, first, second])
  report.tasks.push({ viewport, task: 'players-preseason', entry: '/league?tab=settings', taps: taps.value, label: '2092–93 avg', order: ['Zeta Webkit', 'Beta Webkit'], fp: [120, 60] })
  await checked(admin.from('nba_games').update({ status: 'Final' }).eq('id', games[1]))
  await checked(admin.from('player_game_stats').insert([
    { player_id: players[0], game_id: games[1], season_year: year, week_number: 1, points: 5, minutes_played: 30 },
    { player_id: players[1], game_id: games[1], season_year: year, week_number: 1, points: 15, minutes_played: 30 },
  ]))
  await mainSettings(page)
  const afterTaps = { value: 0 }
  await tap(page.getByRole('link', { name: 'Players', exact: true }), afterTaps)
  await page.waitForFunction(() => document.querySelector('[data-testid="players-average-season"]')?.textContent === '2093–94 avg')
  positions = await Promise.all([second.boundingBox(), first.boundingBox()])
  assert.ok(positions[0] && positions[1] && positions[0].y < positions[1].y, 'First Final changes order without refreshing caches')
  assert.ok((await page.locator('body').innerText()).includes('30.0'))
  await geometry(page, `${viewport}-players-first-final`, [label, second, first])
  report.tasks.push({ viewport, task: 'players-first-final', entry: '/league?tab=settings', taps: afterTaps.value, label: '2093–94 avg', order: ['Beta Webkit', 'Zeta Webkit'], fp: [30, 10], cacheRefreshAfterFinal: false })
}
async function pwa(page, viewport, context) {
  await page.goto(`${origin}/`)
  await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Browse Players', exact: true }).waitFor()
  const manifest = await page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]')
    const href = link?.getAttribute('href')
    if (!href) throw Error('Missing manifest link')
    const response = await fetch(href)
    const data = await response.json()
    const icons = []
    for (const icon of data.icons) {
      const result = await fetch(icon.src)
      const image = new Image()
      image.src = icon.src
      await image.decode()
      icons.push({ src: icon.src, status: result.status, width: image.naturalWidth, height: image.naturalHeight })
    }
    return { href, status: response.status, data, icons,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
      appleCapable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
      standaloneMedia: matchMedia('(display-mode: standalone)').matches,
      browserMedia: matchMedia('(display-mode: browser)').matches,
      standaloneNavigator: 'standalone' in navigator ? Boolean(navigator.standalone) : null,
      touch: navigator.maxTouchPoints, userAgent: navigator.userAgent,
      secureContext: isSecureContext, serviceWorkerSupported: 'serviceWorker' in navigator }
  })
  assert.equal(manifest.status, 200)
  assert.equal(manifest.data.display, 'standalone')
  assert.equal(manifest.data.start_url, '/')
  assert.equal(manifest.data.scope, '/')
  assert.ok(manifest.icons.every(icon => icon.status === 200 && icon.width > 0 && icon.height > 0))
  assert.match(manifest.viewport ?? '', /viewport-fit=cover/)
  assert.equal(manifest.appleCapable, 'yes')
  await page.reload()
  await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Browse Players', exact: true }).waitFor()
  await geometry(page, `${viewport}-pwa-relaunch`, [page.getByRole('button', { name: 'Browse Players', exact: true })])
  const launch = await page.evaluate(async () => ({
    shellRemaining: !!document.querySelector('[data-pancake-boot-shell]'),
    mainReady: document.body.innerText.includes('No matchup this week yet'),
    shellMark: performance.getEntriesByName('pancake-boot-shell')[0]?.startTime ?? null,
    mountMark: performance.getEntriesByName('pancake-app-mounted')[0]?.startTime ?? null,
    serviceWorkers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map(item => ({ scope: item.scope, active: item.active?.state })) : [],
    controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
  }))
  assert.equal(launch.shellRemaining, false)
  assert.ok(launch.mountMark !== null)
  let offline
  await context.setOffline(true)
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 })
    await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor({ timeout: 8000 })
    offline = await page.evaluate(async () => {
      let blocked = false
      try { await fetch('/release-provenance.json?offline=' + Date.now(), { cache: 'no-store' }) } catch { blocked = true }
      return { online: navigator.onLine, blocked, bodyHasText: document.body.innerText.length > 0 }
    })
    await geometry(page, `${viewport}-pwa-offline`)
  } catch (error) { offline = { failure: error instanceof Error ? error.message : String(error) } }
  finally { await context.setOffline(false) }
  report.tasks.push({ viewport, task: 'pwa-launch-manifest', manifest, launch, offline })
  assert.ok(!('failure' in offline) && offline.blocked && offline.bodyHasText, 'Offline WebKit relaunch fails')
}
try {
  for (let n = 0; n < 2; n++) {
    const suffix = randomUUID().replaceAll('-', '')
    const email = `webkit-${suffix}@example.test`
    const password = `Synthetic-${randomUUID()}!`
    const result = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `wk${suffix.slice(0,12)}`, display_name: `WebKit manager ${n}` } }))
    users.push({ id: result.user.id, email, password })
  }
  sql(`CREATE OR REPLACE FUNCTION public.current_season_year_et(p_now timestamptz DEFAULT now()) RETURNS int LANGUAGE sql STABLE AS $$ SELECT ${year} $$;`)
  await checked(admin.from('leagues').insert({ id: league, name: 'WebKit compact settings', slug: `webkit-${league}`, commissioner_id: users[0].id,
    status: 'offseason', playoff_entrants: 2, playoff_round_lengths: [1], playoff_start_week: 18, scoring_settings: { points: 2 } }))
  await checked(admin.from('league_seasons').insert({ id: season, league_id: league, season_year: year, is_current: true }))
  const members = [randomUUID(), randomUUID()]
  await checked(admin.from('league_members').insert(members.map((id, n) => ({ id, league_id: league, user_id: users[n].id, role: n === 0 ? 'commissioner' : 'manager', team_name: `WebKit team ${n}` }))))
  await checked(admin.from('draft_picks').insert(members.flatMap(id => [1,2,3].map(round => ({ league_id: league, season_year: year, round, original_owner_id: id, current_owner_id: id })))))
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10)
  await checked(admin.from('season_weeks').insert(Array.from({ length: 20 }, (_, n) => ({ season_year: year, week_number: n + 1,
    week_start: new Date(Date.now() + n * 7 * 86400000).toISOString().slice(0,10), week_end: new Date(Date.now() + (n * 7 + 6) * 86400000).toISOString().slice(0,10) }))))
  await checked(admin.from('players').insert(players.map((id, n) => ({ id, first_name: ['Zeta', 'Beta', 'Alpha'][n], last_name: 'Webkit', position: 'PG', eligible_positions: ['PG'], nba_team: 'BOS' }))))
  await checked(admin.from('nba_games').insert(games.map((id, n) => ({ id, season_year: year - 1 + n, nba_game_id: n ? '0029400001' : '0029300001', game_date: n ? tomorrow : '2093-01-02', week_number: 1, home_team: 'BOS', away_team: 'NYK', status: n ? 'Scheduled' : 'Final' }))))
  await checked(admin.from('player_game_stats').insert([0,1].map(n => ({ player_id: players[n], game_id: games[0], season_year: year - 1, week_number: 1, points: n ? 30 : 60, minutes_played: 30 }))))
  browser = await webkit.launch({ headless: true })
  report.browserVersion = browser.version()
  for (const viewport of ['iphone', 'desktop']) {
    for (const mode of ['settings', 'pwa']) {
    const context = await browser.newContext(viewport === 'iphone'
      ? { ...devices['iPhone 14 Pro'], viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles', colorScheme: 'light', serviceWorkers: mode === 'pwa' ? 'allow' : 'block' }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'America/Los_Angeles', colorScheme: 'light', serviceWorkers: mode === 'pwa' ? 'allow' : 'block' })
    try {
      await context.route('**/*', route => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'data:' ? route.continue() : route.abort()
      })
      await context.route(`${keys.API_URL}/functions/v1/api/**`, async route => {
        const url = route.request().url().replace(keys.API_URL + '/functions/v1/api', 'http://127.0.0.1:58081/functions/v1/api')
        const response = await route.fetch({ url })
        report.apiResponses.push({ path: new URL(url).pathname, status: response.status(), body: await response.json() })
        await route.fulfill({ response })
      })
      const publicClient = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      const auth = await checked(publicClient.auth.signInWithPassword({ email: users[0].email, password: users[0].password }))
      await context.addInitScript(({ session, authKey }) => {
        Reflect.set(window, '__pancakeAlerts', [])
        Reflect.set(window, '__webkitTouchStarts', 0)
        addEventListener('touchstart', () => Reflect.set(window, '__webkitTouchStarts', Reflect.get(window, '__webkitTouchStarts') + 1))
        if (!localStorage.getItem(authKey)) localStorage.setItem(authKey, JSON.stringify(session))
      }, { session: auth.session, authKey: `sb-${new URL(keys.API_URL).hostname.split('.')[0]}-auth-token` })
      activePage = await context.newPage()
      activePage.setDefaultTimeout(15000)
      activePage.on('pageerror', error => report.consoleErrors.push({ viewport, message: error.message }))
      for (const [name, work] of [
        ['notifications', () => notifications(activePage, viewport)],
        ['timer', () => timer(activePage, viewport)],
        ['playoffs', () => playoffs(activePage, viewport)],
        ['players', () => playerList(activePage, viewport)],
        ['pwa', () => pwa(activePage, viewport, context)],
      ]) {
        const only = process.argv.find(value => value.startsWith('--only='))?.split('=')[1]
        if ((mode === 'pwa') === (name === 'pwa') && (!only || name === only)) await task(activePage, viewport, name, work)
      }
      if (mode === 'settings') {
        const input = await activePage.evaluate(() => ({ touchStarts: Reflect.get(window, '__webkitTouchStarts'), maxTouchPoints: navigator.maxTouchPoints }))
        report.inputs.push({ viewport, ...input })
        if (viewport === 'iphone') assert.ok(input.touchStarts > 0, 'Mobile interactions emit real emulated touch events')
      }
    } finally { await context.close() }
    }
  }
} finally {
  if (browser) { await browser.close(); report.cleanup.push('Owned WebKit browser and all fresh contexts closed') }
  sql(savedYear)
  assert.equal(sql("SELECT pg_get_functiondef('public.current_season_year_et(timestamptz)'::regprocedure)"), savedYear)
  await checked(admin.from('player_game_stats').delete().in('game_id', games))
  await checked(admin.from('nba_games').delete().in('id', games))
  await checked(admin.from('players').delete().in('id', players))
  await checked(admin.from('season_weeks').delete().eq('season_year', year))
  await checked(admin.from('leagues').delete().eq('id', league))
  for (const user of users) await checked(admin.auth.admin.deleteUser(user.id))
  sql('SELECT public.refresh_player_search_caches();')
  report.cleanup.push('Synthetic rows removed; season function restored; caches refreshed')
  report.seconds = (performance.now() - started) / 1000
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ surfaces: report.surfaces.length, tasks: report.tasks.length, findings: report.findings, consoleErrors: report.consoleErrors, evidence }))
if (report.findings.length || report.consoleErrors.length) process.exitCode = 1
