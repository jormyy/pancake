import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, readWebLayout, waitForWebTargetReads } from './web-targets-browser.mjs'

const started = performance.now()
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(frontend-url|api-url|api-proxy-port|db-port|build-sha|run)=(.+)$/.exec(value)
  assert.ok(match, `Invalid argument ${value}`)
  return [match[1], match[2]]
}))
const localOrigin = value => {
  const url = new URL(value)
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Owned HTTP loopback origin required')
  return url.origin
}
const localPort = value => {
  assert.ok(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535, 'Valid local port required')
  return String(Number(value))
}
const origin = localOrigin(args['frontend-url'] ?? process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:58080')
const apiUrl = localOrigin(args['api-url'] ?? process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:58021')
const apiProxyUrl = new URL(apiUrl)
apiProxyUrl.port = localPort(args['api-proxy-port'] ?? process.env.E2E_API_PROXY_PORT ?? '58081')
const apiProxyOrigin = apiProxyUrl.origin
const dbPort = localPort(args['db-port'] ?? process.env.PANCAKE_TEST_DB_PORT ?? '58022')
const buildSha = args['build-sha'] ?? process.env.PANCAKE_RELEASE_SHA
const run = args.run ?? '1'
assert.match(run, /^[a-zA-Z0-9-]+$/)
const evidence = path.resolve(process.env.PLAYERS_SCROLL_EVIDENCE ?? `evidence/t9/browser-${run}`)
const status = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const keys = Object.fromEntries(status.split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
assert.equal(localOrigin(keys.API_URL), apiUrl, 'Supabase status must match the supplied API origin')
const database = new URL(keys.DB_URL)
assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', 'localhost'].includes(database.hostname)
  && database.port === dbPort, 'Owned loopback database must match the supplied port')
const catalog = await import(new URL('../../supabase/functions/_shared/notificationsPreferences.ts', import.meta.url).href)
const finalEvent = catalog.notificationEvents.at(-1)
assert.equal(finalEvent.key, 'league_settings_changed')
const finalEventLabel = `${catalog.notificationCategories[finalEvent.category]}: ${finalEvent.label}`
const categories = Object.values(catalog.notificationCategories)
const checked = async query => {
  const { data, error } = await query
  if (error) throw error
  return data
}
const admin = createClient(apiUrl, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const publicClient = createClient(apiUrl, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const report = {
  run, provenance: 'SYNTHETIC local account and league; real notification catalog and release UI',
  targets: { origin, apiUrl, apiProxyOrigin, dbPort, expectedBuildSha: buildSha ?? null },
  catalog: { finalEvent: finalEvent.key, finalEventLabel, categories, events: catalog.notificationEvents.length },
  simulation: '393x852 DPR 3, mobile and touch enabled; existing web-target helper replaces CSS safe-area env() values with 59/34 px in both engines',
  limitations: ['Not native iOS Safari, an installed home-screen PWA, or real-device evidence', 'WebKit safe-area values are CSS test substitutions, not engine or OS safe-area emulation'],
  release: null, engines: [], cleanup: [], seconds: 0,
}
let userId
let leagueId
await mkdir(evidence, { recursive: true })
async function capture(page, directory, name) {
  const file = path.join(directory, `${name}.png`)
  await page.screenshot({ path: file, animations: 'disabled' })
  return path.relative(evidence, file)
}
async function reachSettingsTab(page, result, directory) {
  await page.goto(`${origin}/league?tab=standings`)
  const strip = page.getByRole('tablist', { name: 'League sections', exact: true })
  await strip.waitFor()
  const settings = strip.getByRole('tab', { name: 'Settings', exact: true })
  const before = await settings.boundingBox()
  const track = await strip.boundingBox()
  assert.ok(before && track)
  const visibleLeft = Math.max(0, track.x, before.x)
  const visibleRight = Math.min(393, track.x + track.width, before.x + before.width)
  const gestures = []
  if (visibleRight > visibleLeft) {
    await page.touchscreen.tap((visibleLeft + visibleRight) / 2, before.y + before.height / 2)
    gestures.push('touch visible part of Settings')
  } else if (result.engine === 'webkit') {
    result.leagueTab = { status: 'NOT_VERIFIED', entry: '/league?tab=standings', before, track,
      reason: 'Settings is outside the strip; Playwright mobile WebKit does not support wheel input or a touch-drag API',
      screenshot: await capture(page, directory, 'settings-tab-unreached') }
    return
  } else {
    await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2)
    await page.mouse.wheel(700, 0)
    gestures.push('horizontal wheel gesture on tab strip')
  }
  await page.waitForFunction(() => {
    const strip = document.querySelector('[role="tablist"][aria-label="League sections"]')
    const settings = strip?.querySelector('[role="tab"][aria-label="Settings"]')
    if (!strip || !settings) return false
    const outer = strip.getBoundingClientRect(), inner = settings.getBoundingClientRect()
    return inner.left >= outer.left - 1 && inner.right <= outer.right + 1
  })
  if (gestures.length === 1 && gestures[0] === 'horizontal wheel gesture on tab strip') {
    await settings.tap()
    gestures.push('touch Settings')
  }
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-label="Settings"]')?.getAttribute('aria-selected') === 'true')
  await page.getByRole('button', { name: 'Open profile and settings', exact: true }).waitFor()
  await waitForWebTargetReads(page)
  const selected = await settings.boundingBox()
  const afterTrack = await strip.boundingBox()
  assert.ok(selected && afterTrack && selected.x >= afterTrack.x - 1 && selected.x + selected.width <= afterTrack.x + afterTrack.width + 1)
  const width = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  assert.equal(width.width, width.scrollWidth)
  result.leagueTab = { status: 'PASS', entry: '/league?tab=standings', gestures, before, track, selected, afterTrack, ...width,
    screenshot: await capture(page, directory, 'settings-tab-reached') }
}
async function expandedEnd(page, result, directory, user) {
  await page.goto(`${origin}/league?tab=settings`)
  let taps = 0
  await page.getByRole('button', { name: 'Open profile and settings', exact: true }).tap(); taps++
  await page.getByRole('button', { name: 'Notification settings', exact: true }).tap(); taps++
  await page.getByRole('switch', { name: 'All notifications', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Collapse all', exact: true }).tap(); taps++
  await page.getByRole('button', { name: 'Expand all', exact: true }).tap(); taps++
  await waitForWebTargetReads(page)
  for (const category of categories) {
    assert.equal(await page.getByRole('button', { name: `${category} events`, exact: true }).getAttribute('aria-expanded'), 'true')
  }
  assert.equal(await page.getByRole('switch').count(), catalog.notificationEvents.length + categories.length + 1)
  const event = page.getByRole('switch', { name: finalEventLabel, exact: true })
  const device = page.getByText('This device', { exact: true }).locator('..').locator('..')
  await device.waitFor()
  await page.waitForFunction(() => {
    const label = [...document.querySelectorAll('*')].find(node => node.childElementCount === 0 && node.textContent === 'This device')
    return (label?.parentElement?.textContent?.trim().length ?? 0) > 'This device'.length
  })
  const scrolls = await device.evaluate(element => {
    element.scrollIntoView({ block: 'end', inline: 'nearest' })
    const positions = []
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
        node.scrollTop = node.scrollHeight
        positions.push({ top: node.scrollTop, max: node.scrollHeight - node.clientHeight, height: node.clientHeight })
      }
    }
    return positions
  })
  assert.ok(scrolls.length && scrolls.every(item => Math.abs(item.top - item.max) <= 1), 'Actual scrollable ancestors reach their end')
  await page.waitForTimeout(250)
  const nav = await page.getByRole('navigation', { name: 'Primary', exact: true }).boundingBox()
  const header = await page.getByRole('heading', { name: 'Notifications', exact: true }).evaluate(element => {
    const box = element.parentElement.parentElement.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
  })
  const eventBox = await event.boundingBox()
  const deviceBox = await device.boundingBox()
  const deviceButtons = await device.getByRole('button').allTextContents()
  const deviceText = await device.innerText()
  const layout = await readWebLayout(page, { top: 59, bottom: 34 })
  result.notifications = { status: 'MEASURED', entry: '/league?tab=settings', taps, expandedCategories: categories.length,
    finalEventLabel, eventBox, deviceBox, deviceButtons, deviceText, scrolls, header, nav, layout,
    fixtureUser: user.id, screenshot: await capture(page, directory, 'notifications-expanded-scroll-end') }
  console.log(JSON.stringify({ engine: result.engine, ...result.notifications }))
  assert.equal(layout.client.width, 393)
  assert.equal(layout.client.height, 852)
  assert.equal(layout.client.dpr, 3)
  assert.equal(layout.overflow, 0, 'Document width equals viewport width')
  assert.equal(layout.mainPadding.top, 115)
  assert.equal(layout.mainPadding.bottom, 98)
  assert.ok(nav && eventBox && deviceBox)
  for (const [name, box] of [['final event', eventBox], ['final Web Push region', deviceBox]]) {
    assert.ok(box.y >= header.bottom, `${name} starts under the header`)
    assert.ok(box.y + box.height <= nav.y, `${name} ends under Primary navigation: bottom ${box.y + box.height}, nav top ${nav.y}`)
    assert.ok(box.x >= 0 && box.x + box.width <= 393, `${name} fits the viewport width`)
  }
  result.notifications.status = 'PASS'
}
try {
  const release = await fetch(`${origin}/release-provenance.json`).then(response => response.json())
  if (buildSha) assert.equal(release.commitSha, buildSha)
  report.release = { commitSha: release.commitSha, bundleDigest: release.bundleDigest }
  const suffix = randomUUID().replaceAll('-', '')
  const email = `players-scroll-${suffix}@example.test`
  const password = `Synthetic-${randomUUID()}!`
  const created = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `ps${suffix.slice(0,12)}`, display_name: 'Players scroll check' } }))
  userId = created.user.id
  const signed = await checked(publicClient.auth.signInWithPassword({ email, password }))
  const league = await checked(publicClient.rpc('create_league', { p_name: 'Expanded notification check', p_team_name: 'Scroll team', p_auction_budget: 200 }))
  leagueId = league.id
  for (const engine of ['webkit', 'chromium']) {
    const directory = path.join(evidence, engine)
    await mkdir(directory, { recursive: true })
    const result = { engine, status: 'FAIL', errors: [], notifications: null, leagueTab: null, failures: [] }
    report.engines.push(result)
    const target = { engine, mobile: true, standalone: false, viewport: { width: 393, height: 852 }, insets: { top: 59, bottom: 34 } }
    const { browser, context, page } = await openWebTarget(target, directory, { deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    try {
      page.setDefaultTimeout(15000)
      result.engineVersion = browser.version()
      page.on('pageerror', error => result.errors.push(error.message))
      await context.route('**/*', route => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'data:' ? route.continue() : route.abort()
      })
      await context.route(`${apiUrl}/functions/v1/api/**`, async route => {
        const response = await route.fetch({ url: route.request().url().replace(apiUrl, apiProxyOrigin) })
        await route.fulfill({ response })
      })
      await context.addInitScript(({ session, authKey }) => {
        if (!localStorage.getItem(authKey)) localStorage.setItem(authKey, JSON.stringify(session))
      }, { session: signed.session, authKey: `sb-${new URL(apiUrl).hostname.split('.')[0]}-auth-token` })
      try { await expandedEnd(page, result, directory, created.user) }
      catch (error) {
        result.failures.push({ check: 'expanded-scroll-end', error: error instanceof Error ? error.message : String(error), screenshot: await capture(page, directory, 'expanded-scroll-end-failure') })
      }
      try { await reachSettingsTab(page, result, directory) }
      catch (error) {
        result.failures.push({ check: 'settings-tab-reach', error: error instanceof Error ? error.message : String(error), screenshot: await capture(page, directory, 'settings-tab-reach-failure') })
      }
      result.status = result.failures.length ? 'FAIL' : 'PASS'
    } finally {
      await context.close()
      await browser.close()
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(result, null, 2) + '\n')
    }
  }
} finally {
  if (leagueId) await checked(admin.from('leagues').delete().eq('id', leagueId))
  if (userId) await checked(admin.auth.admin.deleteUser(userId))
  report.cleanup.push('Owned contexts and browsers closed; synthetic league and account removed')
  report.seconds = (performance.now() - started) / 1000
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ evidence, engines: report.engines.map(result => ({ engine: result.engine, status: result.status, failures: result.failures })), seconds: report.seconds }))
if (report.engines.length !== 2 || report.engines.some(result => result.status !== 'PASS')) process.exitCode = 1
