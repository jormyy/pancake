import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2])
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
assert.ok(!run.cleanedAt)
requireLocal(run.url)
const evidence = path.join(path.dirname(dir), 'pwa')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const observe = () => JSON.parse(execFileSync(process.execPath, [new URL('./observe.mjs', import.meta.url).pathname, dir], { encoding: 'utf8' }))
const save = async label => {
  await page.screenshot({ path: path.join(evidence, label + '.png') })
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }))
  await writeFile(path.join(evidence, label + '-layout.json'), JSON.stringify(layout))
  assert.ok(layout.scrollWidth <= layout.width, 'Horizontal overflow')
  await writeFile(path.join(evidence, label + '.txt'), await page.locator('body').ariaSnapshot())
  await writeFile(path.join(evidence, label + '-database.json'), JSON.stringify(observe(), null, 2))
}
const probe = () => page.evaluate(async () => {
  let blocked = false
  try { await fetch('/release-provenance.json?offline-probe=' + Date.now(), { cache: 'no-store' }) } catch { blocked = true }
  return { online: navigator.onLine, blocked, release: document.querySelector('meta[name=pancake-release]')?.getAttribute('content') }
})
const results = []
try {
  await page.goto(run.url + '/sign-in')
  await page.waitForTimeout(1500)
  await page.getByPlaceholder('you@example.com').fill(state.users[0].email)
  await page.getByPlaceholder('Your password').fill(state.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  await page.getByRole('link', { name: 'Roster', exact: true }).waitFor()
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await page.getByRole('link', { name: 'Roster', exact: true }).waitFor()
  for (const width of [390, 375]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 812 })
    await page.getByRole('link', { name: 'Roster', exact: true }).click()
    await page.getByRole('heading', { name: 'Roster', exact: true }).waitFor()
    await page.getByRole('link', { name: 'Matchup', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('E2E Team 1'))
    await page.waitForTimeout(1500)
    const online = await probe()
    assert.equal(online.online, true)
    assert.match(online.release, /^pancake-/)
    await save('cold-online-' + width)
    const databaseBefore = observe()
    await context.setOffline(true)
    const before = await probe()
    assert.equal(before.online, false)
    assert.equal(before.blocked, true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('E2E Team 1') && document.body.innerText.includes('Offline'))
    const offline = await probe()
    assert.equal(offline.online, false)
    assert.equal(offline.blocked, true)
    assert.equal(offline.release, online.release)
    await save('cold-offline-' + width)
    await page.getByRole('link', { name: 'Roster', exact: true }).click()
    await page.getByRole('heading', { name: 'Roster', exact: true }).waitFor()
    assert.match(await page.locator('body').innerText(), /Offline/)
    await save('cold-roster-' + width)
    await context.setOffline(false)
    await page.reload()
    await page.waitForFunction(() => !document.body.innerText.includes('Offline'))
    await page.getByRole('link', { name: 'Matchup', exact: true }).click()
    await page.waitForFunction(() => document.body.innerText.includes('E2E Team 1'))
    await save('cold-reconnected-' + width)
    const databaseAfter = observe()
    for (const table of ['roster_players', 'weekly_lineups', 'lineup_player_pins', 'waiver_claims', 'trades']) {
      const ordered = rows => rows.map(row => JSON.stringify(row)).sort()
      assert.deepEqual(ordered(databaseAfter[table]), ordered(databaseBefore[table]), table + ' changes during offline reading')
    }
    results.push({ width, online, offline, reconnect: await probe(), databaseUnchanged: true })
  }
  assert.deepEqual(pageErrors, [])
  await writeFile(path.join(evidence, 'cold-offline-results.json'), JSON.stringify({ passed: true, results, pageErrors }, null, 2))
  console.log(JSON.stringify({ passed: true, widths: results.map(row => row.width) }))
} catch (error) {
  await save('cold-offline-failed').catch(() => {})
  throw error
} finally {
  await browser.close()
}
