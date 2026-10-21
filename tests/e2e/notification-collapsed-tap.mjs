import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, readWebLayout, waitForWebTargetReads } from './web-targets-browser.mjs'

// Counts the taps from the League Settings panel to one event switch inside a notification category that starts
// collapsed, for every such category and for its first and last event, by two routes: scrolling to the category (direct)
// or tapping Collapse all first. Every tap must toggle exactly that event on screen and in notification_preferences.
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
  assert.ok(!/^(582|543)\d\d$/.test(value), 'Refuse the protected replay (582xx) and orchestrator (543xx) blocks')
  return String(Number(value))
}
const origin = localOrigin(args['frontend-url'] ?? process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:58080')
const apiUrl = localOrigin(args['api-url'] ?? process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:58021')
for (const url of [origin, apiUrl]) localPort(new URL(url).port || '80')
const apiProxyUrl = new URL(apiUrl)
apiProxyUrl.port = localPort(args['api-proxy-port'] ?? process.env.E2E_API_PROXY_PORT ?? '58081')
const apiProxyOrigin = apiProxyUrl.origin
const dbPort = localPort(args['db-port'] ?? process.env.PANCAKE_TEST_DB_PORT ?? '58022')
const buildSha = args['build-sha'] ?? process.env.PANCAKE_RELEASE_SHA
const run = args.run ?? '1'
assert.match(run, /^[a-zA-Z0-9-]+$/)
const evidence = path.resolve(process.env.NOTIFICATION_TAP_EVIDENCE ?? `evidence/notification-collapsed-tap/run-${run}`)
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
const checked = async query => {
  const { data, error } = await query
  if (error) throw error
  return data
}
const admin = createClient(apiUrl, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const publicClient = createClient(apiUrl, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const report = {
  run, provenance: 'SYNTHETIC local accounts and leagues; real notification catalog, release UI and preference persistence',
  targets: { origin, apiUrl, apiProxyOrigin, dbPort, expectedBuildSha: buildSha ?? null },
  convention: 'Taps count from the visible League Settings panel (/league?tab=settings); the first counted tap opens profile and settings. Scrolls are counted separately and are not taps.',
  simulation: '393x852 DPR 3, mobile and touch enabled, fresh automation contexts; the web-target helper replaces CSS safe-area env() values with 59/34 px',
  limitations: ['Not native iOS Safari, an installed home-screen PWA, or real-device evidence', 'Scroll steps are programmatic scrollIntoView calls standing in for a finger swipe; Playwright mobile WebKit has no wheel or touch-drag input'],
  release: null, engines: [], cleanup: [], seconds: 0,
}
const fixtures = []
await mkdir(evidence, { recursive: true })
const preferenceRow = async userId => checked(admin.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle())
const DEFAULT_ROW = { trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true, master_enabled: true, category_settings: {}, event_settings: {} }
const stored = row => {
  const { updated_at: _updated, user_id: _user, ...rest } = row ?? DEFAULT_ROW
  return rest
}
async function switchStates(page) {
  return page.getByRole('switch').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute('aria-label'), node.getAttribute('aria-checked')])))
}
// A target is tappable without scrolling when the top, middle and bottom of its centre line hit-test to it,
// so neither the sticky screen header nor Primary navigation covers it.
async function inView(page, locator) {
  const box = await locator.boundingBox()
  const nav = await page.getByRole('navigation', { name: 'Primary', exact: true }).boundingBox()
  const points = box ? [box.y + 2, box.y + box.height / 2, box.y + box.height - 2].map(y => [box.x + box.width / 2, y]) : []
  const hits = await locator.evaluate((element, points) => points.map(([x, y]) => element.contains(document.elementFromPoint(x, y))), points)
  return { box, navTop: nav?.y ?? null, hits, visible: !!box && hits.length === 3 && hits.every(Boolean) && box.x >= 0 && box.x + box.width <= 393 }
}
async function flow(page, engine, user, category, event, position, route, directory) {
  const label = catalog.notificationCategories[category]
  const eventLabel = `${label}: ${event.label}`
  const prefix = `${category}-${position}-${route}`
  const steps = []
  let taps = 0, scrolls = 0
  const shot = async name => {
    const file = path.join(directory, `${prefix}-${String(steps.length).padStart(2, '0')}-${name}.png`)
    await page.screenshot({ path: file, animations: 'disabled' })
    return path.relative(evidence, file)
  }
  const reach = async (locator, name) => {
    let view = await inView(page, locator)
    if (!view.visible) {
      await locator.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
      await page.waitForTimeout(250)
      scrolls++
      view = await inView(page, locator)
      steps.push({ action: 'scroll', target: name, ...view, screenshot: await shot(`scroll-${name}`) })
    }
    assert.ok(view.visible, `${name} must be fully visible between the header and Primary navigation before its tap`)
    return view
  }
  const tap = async (locator, name, after) => {
    const view = await reach(locator, name)
    await locator.tap()
    taps++
    await after()
    const pointer = await page.evaluate(() => Reflect.get(window, '__webTargetPointer') ?? null)
    steps.push({ action: 'tap', target: name, ...view, pointer, screenshot: await shot(name) })
  }
  await page.goto(`${origin}/league?tab=settings`)
  const profile = page.getByRole('button', { name: 'Open profile and settings', exact: true })
  await profile.waitFor()
  await waitForWebTargetReads(page)
  steps.push({ action: 'entry', target: '/league?tab=settings', screenshot: await shot('entry') })
  const notifications = page.getByRole('button', { name: 'Notification settings', exact: true })
  await tap(profile, 'open-profile-and-settings', () => notifications.waitFor())
  const master = page.getByRole('switch', { name: 'All notifications', exact: true })
  await tap(notifications, 'open-notification-settings', async () => { await master.waitFor(); await waitForWebTargetReads(page) })
  const header = page.getByRole('button', { name: `${label} events`, exact: true })
  const target = page.getByRole('switch', { name: eventLabel, exact: true })
  assert.equal(await header.getAttribute('aria-expanded'), 'false', `${label} must start collapsed`)
  assert.equal(await target.count(), 0, `${eventLabel} is not rendered while ${label} is collapsed`)
  if (route === 'collapse-first') {
    const collapse = page.getByRole('button', { name: 'Collapse all', exact: true })
    await tap(collapse, 'collapse-all', () => page.getByRole('button', { name: 'Expand all', exact: true }).waitFor())
  }
  await tap(header, `expand-${category}`, async () => {
    await page.waitForFunction(name => document.querySelector(`[role="button"][aria-label="${name}"]`)?.getAttribute('aria-expanded') === 'true', `${label} events`)
    await target.waitFor()
  })
  const uiBefore = await switchStates(page)
  const rowBefore = await preferenceRow(user.id)
  const effective = (rowBefore?.event_settings ?? {})[event.key] ?? event.defaultEnabled
  assert.equal(uiBefore[eventLabel], String(effective), `${eventLabel} shows the stored preference before the tap`)
  let rowAfter
  await tap(target, `toggle-${event.key}`, async () => {
    await page.waitForFunction(([name, value]) => document.querySelector(`[role="switch"][aria-label="${name}"]`)?.getAttribute('aria-checked') === value, [eventLabel, String(!effective)])
    const deadline = Date.now() + 15000
    do {
      rowAfter = await preferenceRow(user.id)
      if (rowAfter?.event_settings?.[event.key] === !effective) break
      await page.waitForTimeout(100)
    } while (Date.now() < deadline)
    await waitForWebTargetReads(page)
    rowAfter = await preferenceRow(user.id)
  })
  const uiAfter = await switchStates(page)
  const changedSwitches = Object.keys({ ...uiBefore, ...uiAfter }).filter(name => uiBefore[name] !== uiAfter[name])
  const expectedRow = { ...stored(rowBefore), event_settings: { ...stored(rowBefore).event_settings, [event.key]: !effective } }
  const result = { engine, category, position, route, event: event.key, eventLabel, taps, scrolls, tapsFromMainSettings: taps - 1, steps, changedSwitches,
    storedBefore: rowBefore ? stored(rowBefore) : null, storedAfter: stored(rowAfter), expectedStored: expectedRow }
  assert.deepEqual(changedSwitches, [eventLabel], 'Exactly the tapped event switch changes on screen')
  assert.deepEqual(stored(rowAfter), expectedRow, 'Only the tapped event preference changes in notification_preferences')
  assert.equal(taps, route === 'direct' ? 4 : 5)
  console.log(JSON.stringify({ engine, category, position, route, event: event.key, taps, scrolls }))
  return result
}
try {
  const release = await fetch(`${origin}/release-provenance.json`).then(response => response.json())
  if (buildSha) assert.equal(release.commitSha, buildSha)
  report.release = { commitSha: release.commitSha, bundleDigest: release.bundleDigest }
  for (const engine of ['webkit', 'chromium']) {
    const directory = path.join(evidence, engine)
    await mkdir(directory, { recursive: true })
    const result = { engine, status: 'FAIL', errors: [], collapsedAtOpen: [], flows: [], failures: [] }
    report.engines.push(result)
    const suffix = randomUUID().replaceAll('-', '')
    const email = `collapsed-tap-${suffix}@example.test`
    const password = `Synthetic-${randomUUID()}!`
    const created = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `ct${suffix.slice(0, 12)}`, display_name: 'Collapsed tap check' } }))
    const fixture = { userId: created.user.id, leagueId: null }
    fixtures.push(fixture)
    const signed = await checked(publicClient.auth.signInWithPassword({ email, password }))
    fixture.leagueId = (await checked(publicClient.rpc('create_league', { p_name: 'Collapsed notification check', p_team_name: 'Tap team', p_auction_budget: 200 }))).id
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
      await page.goto(`${origin}/league?tab=settings`)
      await page.getByRole('button', { name: 'Open profile and settings', exact: true }).tap()
      await page.getByRole('button', { name: 'Notification settings', exact: true }).tap()
      await page.getByRole('switch', { name: 'All notifications', exact: true }).waitFor()
      for (const [category, label] of Object.entries(catalog.notificationCategories)) {
        if (await page.getByRole('button', { name: `${label} events`, exact: true }).getAttribute('aria-expanded') === 'false') result.collapsedAtOpen.push(category)
      }
      result.layout = await readWebLayout(page, { top: 59, bottom: 34 })
      assert.equal(result.layout.overflow, 0, 'Document width equals viewport width')
      assert.ok(result.collapsedAtOpen.length > 0, 'At least one category starts collapsed')
      for (const category of result.collapsedAtOpen) {
        const events = catalog.notificationEvents.filter(event => event.category === category)
        for (const [position, event] of [['first', events[0]], ['last', events.at(-1)]]) for (const route of ['direct', 'collapse-first']) {
          try { result.flows.push(await flow(page, engine, created.user, category, event, position, route, directory)) }
          catch (error) {
            const file = path.join(directory, `${category}-${position}-${route}-failure.png`)
            await page.screenshot({ path: file, animations: 'disabled' })
            result.failures.push({ category, position, route, event: event.key, error: error instanceof Error ? error.message : String(error), screenshot: path.relative(evidence, file) })
          }
        }
      }
      result.status = result.failures.length || result.errors.length ? 'FAIL' : 'PASS'
    } finally {
      await context.close()
      await browser.close()
      await writeFile(path.join(directory, 'report.json'), JSON.stringify(result, null, 2) + '\n')
    }
  }
} finally {
  for (const { userId, leagueId } of fixtures) {
    if (leagueId) await checked(admin.from('leagues').delete().eq('id', leagueId))
    await checked(admin.from('notification_preferences').delete().eq('user_id', userId))
    await checked(admin.auth.admin.deleteUser(userId))
  }
  report.cleanup.push('Owned contexts and browsers closed; synthetic leagues, preference rows and accounts removed')
  report.seconds = (performance.now() - started) / 1000
  report.summary = report.engines.map(result => ({ engine: result.engine, status: result.status, collapsedAtOpen: result.collapsedAtOpen,
    flows: result.flows.map(({ category, position, route, event, taps, tapsFromMainSettings, scrolls }) => ({ category, position, route, event, taps, tapsFromMainSettings, scrolls })), failures: result.failures }))
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ evidence, summary: report.summary, seconds: report.seconds }))
if (report.engines.length !== 2 || report.engines.some(result => result.status !== 'PASS')) process.exitCode = 1
