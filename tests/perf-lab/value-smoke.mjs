import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { expectContent } from '../../scripts/perf-lab/actions.mjs'
import { installContentProbe } from '../../scripts/perf-lab/walk.mjs'

const browser = await webkit.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await page.setContent('<main id="root"><select id="season"><option>2027</option><option>2026</option></select><div id="games">Recent games</div><textarea id="note">Old note</textarea><input id="name" value=""></main>')
  const season = { selector: '#games', value: { selector: '#season', equals: '2026' } }
  await assert.rejects(expectContent(page, season, page.url()))
  await page.evaluate(installContentProbe, season)
  assert.equal(await page.evaluate(() => window.__perfLabFirstContentMs), undefined)
  await page.selectOption('#season', '2026')
  await page.locator('#games').evaluate(element => { element.textContent = 'Recent games for 2026' })
  await expectContent(page, season, page.url())
  await page.waitForFunction(() => Number.isFinite(window.__perfLabFirstContentMs))
  await page.locator('#note').fill('New note')
  await expectContent(page, { selector: '#note', value: { selector: '#note', equals: 'New note' } }, page.url())
  await expectContent(page, { value: { selector: '#name', equals: '' } }, page.url())
  console.log(JSON.stringify({ passed: 5, failed: 0, scope: 'WebKit field-value and first-content contracts; no application route coverage' }))
} finally { await browser.close() }
