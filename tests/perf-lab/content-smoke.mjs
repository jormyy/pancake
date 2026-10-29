import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { installContentProbe } from '../../scripts/perf-lab/walk.mjs'
import { expectedSurface } from '../../scripts/perf-lab/surfaces.mjs'
import { expectContent } from '../../scripts/perf-lab/actions.mjs'
import { phoneProfile } from '../../scripts/perf-lab/device.mjs'
import { fileURLToPath } from 'node:url'

export async function checkSectionContent() {
  const browser = await webkit.launch({ headless: true })
  try {
    const page = await browser.newPage(phoneProfile)
    await page.setContent('<main><button id="players-section-players" aria-selected="true">Players</button><div id="root"><div id="players-section-panel"></div></div></main>')
    const expected = expectedSurface({ id: 'players.players' }, {}, 'commissioner')
    await page.evaluate(installContentProbe, expected)
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.__perfLabFirstContentMs), undefined, 'Selected tab alone cannot prove content')
    await page.locator('#players-section-panel').evaluate(element => { element.innerHTML = '<div data-testid="player-row-content">Fixture Player</div>' })
    await expectContent(page, expected, page.url())
    await page.waitForFunction(() => Number.isFinite(window.__perfLabFirstContentMs))
    await page.setContent('<main><aside>Recent results</aside><section id="active-panel"></section></main>')
    await page.evaluate(() => { delete window.__perfLabFirstContentMs })
    const scoped = { within: '#active-panel', text: 'Recent results' }
    await page.evaluate(installContentProbe, scoped)
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(() => window.__perfLabFirstContentMs), undefined)
    await assert.rejects(expectContent(page, scoped, page.url()))
    await page.locator('#active-panel').evaluate(element => { element.textContent = 'Recent results' })
    await expectContent(page, scoped, page.url())
    await page.waitForFunction(() => Number.isFinite(window.__perfLabFirstContentMs))
    return 'WebKit section checks pass: selected tabs and unrelated text cannot substitute for section content; no application route coverage'
  } finally { await browser.close() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await checkSectionContent())
