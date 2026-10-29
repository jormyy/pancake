import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { labRoot, requireMini } from './perf-lab/common.mjs'
import { localKeys, sql } from './perf-lab/database.mjs'
import { captureBrowserScreenshot, clickButtonByName, createBrowser } from '../tests/e2e/browser-agent.mjs'
import { runWithScenarioResourceOwner } from '../tests/e2e/scenario-resource-owner.mjs'

await requireMini()
process.env.E2E_BROWSER_SCREENSHOT_MODE = 'agent'
process.env.E2E_BROWSER_SCREENSHOT_TIMEOUTS_MS = '15000,15000'
const [label = 'baseline', next = `${label}-next`] = process.argv.slice(2)
assert.match(label, /^[a-z0-9-]+$/)
assert.match(next, /^[a-z0-9-]+$/)
const exec = promisify(execFile)
const agent = createBrowser()
const fixture = JSON.parse(await readFile(path.join(labRoot, 'seed/complete.json'), 'utf8'))
const keys = await localKeys()
const client = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const login = await client.auth.signInWithPassword({ email: fixture.users[0].email, password: fixture.password })
assert.ifError(login.error)
const matchup = await sql(`SELECT id FROM public.matchups WHERE league_id='${fixture.leagueId}' AND home_member_id='${fixture.members[0].id}' ORDER BY week_number LIMIT 1`)
const backend = /^site_url = "([^"]+)"/m.exec(await readFile('supabase/config.toml', 'utf8'))?.[1]
assert.ok(backend && new URL(backend).protocol === 'https:' && new URL(backend).port === '62084' && new URL(backend).hostname.endsWith('.local'))
const hostname = new URL(backend).hostname
const origin = 'http://127.0.0.1:62090'
const clearHttp = process.env.PANCAKE_BYTES_CLEAR_HTTP === '1'
const weekly = process.env.PANCAKE_BYTES_WEEK === '1'
const caseLabel = process.env.PANCAKE_BYTES_CASE ?? (clearHttp ? 'evicted' : '')
assert.match(caseLabel, /^[a-z0-9-]*$/)
const directory = path.join(labRoot, `${label}${caseLabel ? `-${caseLabel}` : ''}-browser`)
await mkdir(directory, { recursive: true })
const routes = [
  ['home', '/'], ['matchup', `/matchup?matchupId=${matchup}`], ['roster', '/roster'], ['players', '/players'],
  ['trades', '/trades'], ['league', '/league'], ['draft-room', `/draft-room?draftId=${fixture.drafts.find(row => row.draft_type === 'auction').id}`],
  ['player', `/player/${fixture.players[0].id}`], ['sign-in', '/sign-in'], ['sign-up', '/sign-up'],
]
const selectedRoutes = process.env.PANCAKE_BYTES_ROUTES?.split(',')
const report = { label, next, clearHttp, rows: [] }
if (selectedRoutes) {
  const prior = await readFile(path.join(directory, 'report.json'), 'utf8').then(JSON.parse).catch(() => null)
  report.rows = prior?.rows.filter(row => !selectedRoutes.includes(row.name)) ?? []
}
const recordsSince = async at => (await readFile(path.join(labRoot, 'static-access.jsonl'), 'utf8').catch(() => ''))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.at >= at)
const sum = rows => rows.reduce((total, row) => total + row.bytes, 0)
const auctionHeld = () => {
  const holds = Reflect.get(window, '__pancakePwaHolds')
  return !!holds && [...holds.values()].some(hold => hold.reason === 'auction room')
}

await runWithScenarioResourceOwner('web transfer measurement', async () => {
for (const [name, route] of routes) {
  if (selectedRoutes && !selectedRoutes.includes(name)) continue
  const session = `fable-bytes-${label}-${name}-${process.pid}`
  let connection
  try {
    await writeFile(path.join(labRoot, 'served-build'), label)
    await exec('agent-browser', ['--session', session, '--ignore-https-errors', '--args', `--host-resolver-rules=MAP ${hostname} 127.0.0.1`, '--allowed-domains', `127.0.0.1,localhost,${hostname}`, 'open', `${origin}/release-provenance.json`], { timeout: 30000 })
    const endpoint = (await agent(session, ['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
    assert.ok(endpoint)
    connection = await chromium.connectOverCDP(endpoint)
    const context = connection.contexts()[0]
    const page = context.pages().find(page => page.url().startsWith(`${origin}/`))
    assert.ok(page, 'The automation tab is missing')
    await page.bringToFront()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    const signedIn = !name.startsWith('sign-')
    if (signedIn) await context.addInitScript(({ session, storageKey }) => {
      if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(session))
      localStorage.setItem('pancake-theme', 'light')
    }, { session: login.data.session, storageKey: `sb-${hostname.split('.')[0]}-auth-token` })
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
    const start = Date.now()
    await agent(session, ['open', `${origin}${route}`])
    await page.bringToFront()
    await page.waitForFunction(() => !document.getElementById('pancake-boot-shell') && (document.getElementById('root')?.textContent?.length ?? 0) > 60, undefined, { timeout: 45000 }).catch(async error => {
      console.error(JSON.stringify({ url: page.url(), text: await page.locator('body').innerText(), state: await page.evaluate(() => ({ visibility: document.visibilityState, root: document.getElementById('root')?.innerHTML.slice(0, 500), storage: Object.keys(localStorage) })), errors }))
      console.error(await agent(session, ['console']))
      throw error
    })
    await page.waitForFunction(() => !document.querySelector('#root [aria-busy="true"]'), undefined, { timeout: 45000 })
    await delay(2000)
    const interactiveAt = Date.now()
    const firstText = await page.locator('#root').innerText()
    assert.equal(new URL(page.url()).pathname, new URL(route, origin).pathname, `${name} redirects unexpectedly`)
    assert.ok(!/Something went wrong|Unable to load|Could not load|supabaseKey is required/i.test(firstText), `${name} shows an error: ${firstText}`)
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', undefined, { timeout: 45000 })
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 45000 })
    await delay(1000)
    const first = await recordsSince(start)
    const snapshot = await agent(session, ['snapshot'])
    await writeFile(path.join(directory, `${name}.txt`), snapshot)
    try { await captureBrowserScreenshot(agent, session, directory, `${name}.png`) }
    catch { await page.screenshot({ path: path.join(directory, `${name}.png`), timeout: 15000, animations: 'disabled' }) }
    let week
    if (weekly && name === 'home') {
      const draftStart = Date.now()
      const draftRoute = routes.find(([name]) => name === 'draft-room')[1]
      await agent(session, ['open', `${origin}${draftRoute}`])
      await page.waitForFunction(() => !document.getElementById('pancake-boot-shell') && !document.querySelector('#root [aria-busy="true"]'), undefined, { timeout: 45000 })
      await page.waitForFunction(auctionHeld, undefined, { timeout: 15000 })
      await delay(2000)
      const draft = await recordsSince(draftStart)
      assert.equal(await page.getByRole('button', { name: 'Back to league drafts', exact: true }).count(), 1)
      const returnStart = Date.now()
      await clickButtonByName(agent, session, 'Back to league drafts')
      await page.waitForFunction(() => location.pathname !== '/draft-room', undefined, { timeout: 15000 })
      await agent(session, ['open', `${origin}/`])
      await page.waitForFunction(() => !document.getElementById('pancake-boot-shell') && !document.querySelector('#root [aria-busy="true"]'), undefined, { timeout: 45000 })
      await delay(2000)
      week = { draft, returnHome: await recordsSince(returnStart) }
    }
    if (name === 'draft-room') {
      await page.waitForFunction(auctionHeld, undefined, { timeout: 15000 })
      await clickButtonByName(agent, session, 'Back to league drafts')
      await page.waitForFunction(() => location.pathname !== '/draft-room', undefined, { timeout: 15000 })
      await page.waitForFunction(() => !document.querySelector('#root [aria-busy="true"]'), undefined, { timeout: 45000 })
      await delay(2000)
    }
    if (clearHttp) await cdp.send('Network.clearBrowserCache')
    const repeatStart = Date.now()
    await writeFile(path.join(labRoot, 'served-build'), next)
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update() })
    const expected = /const VERSION = '([^']+)'/.exec(await readFile(path.join(labRoot, next, 'sw.js'), 'utf8'))[1]
    await page.waitForFunction(expected => document.querySelector('meta[name="pancake-release"]')?.getAttribute('content') === expected, expected, { timeout: 45000 })
    if (name === 'draft-room') await agent(session, ['open', `${origin}${route}`])
    await page.waitForFunction(() => !document.getElementById('pancake-boot-shell') && (document.getElementById('root')?.textContent?.length ?? 0) > 60, undefined, { timeout: 45000 })
    await delay(2000)
    const repeat = await recordsSince(repeatStart)
    await context.setOffline(true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !document.getElementById('pancake-boot-shell') && (document.getElementById('root')?.textContent?.length ?? 0) > 60, undefined, { timeout: 30000 })
    await page.waitForFunction(() => !document.querySelector('#root [aria-busy="true"]:not([data-testid="player-action-slot"])'), undefined, { timeout: 30000 }).catch(async error => {
      await writeFile(path.join(directory, `${name}-offline.txt`), await page.locator('#root').innerText())
      await page.screenshot({ path: path.join(directory, `${name}-offline.png`), timeout: 15000, animations: 'disabled' })
      console.error(await page.locator('#root [aria-busy="true"]').evaluateAll(elements => elements.map(element => element.outerHTML.slice(0, 1000))))
      throw error
    })
    const offlineText = await page.locator('#root').innerText()
    assert.ok(offlineText.length > 60)
    assert.ok(!/Something went wrong|Unable to load|Could not load|supabaseKey is required/i.test(offlineText), `${name} fails offline: ${offlineText}`)
    if (name === 'player') assert.match(offlineText, /SEASON AVERAGES/i)
    await context.setOffline(false)
    assert.deepEqual(errors, [], `${name} throws in the browser`)
    report.rows.push({ name, route, first: first.filter(row => row.at <= interactiveAt), install: first,
      firstBytes: sum(first.filter(row => row.at <= interactiveAt)), installedBytes: sum(first), repeatBytes: sum(repeat), repeat,
      offline: true, screenshot: `${name}.png`, text: firstText, errors, ...(week ? { week } : {}) })
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`${name}: first ${sum(first)} B, repeat ${sum(repeat)} B; offline passed`)
  } finally {
    await connection?.close()
    await agent(session, ['close']).catch(() => {})
  }
}
})
console.log((await exec('agent-browser', ['session', 'list'])).stdout.trim())
