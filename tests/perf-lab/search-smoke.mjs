import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { observeSearch } from '../../scripts/perf-lab/interactions.mjs'
import { requireMini } from '../../scripts/perf-lab/common.mjs'
import { settleControl } from '../../scripts/perf-lab/settle.mjs'
import { phoneProfile, emulateStandalone, phoneEvidence } from '../../scripts/perf-lab/device.mjs'

export async function checkSearchObserver() {
  await requireMini()
  const browser = await webkit.launch({ headless: true })
  try {
    const page = await browser.newPage(phoneProfile)
    await page.addInitScript(emulateStandalone)
    await page.goto('about:blank')
    assert.deepEqual(await page.evaluate(phoneEvidence), { profile: true, touch: true, standalone: true, installedOnDevice: false })
    await page.setContent('<meta name="viewport" content="width=device-width"><main id="root"><input aria-label="Search players" value="Missing"><div data-testid="player-row-content">Jalen Williams</div></main>')
    await page.evaluate(observeSearch)
    assert.equal(await page.evaluate(() => window.__perfLabSearch.some(row => row.ready)), false)
    await page.evaluate(() => {
      let pending
      window.__savedSearch = ''
      document.querySelector('input').addEventListener('input', event => {
        clearTimeout(pending)
        pending = setTimeout(() => { window.__savedSearch = event.target instanceof HTMLInputElement ? event.target.value : '' }, 250)
      })
      window.__touches = 0
      document.querySelector('input').addEventListener('touchstart', () => { window.__touches++ })
    })
    await page.getByLabel('Search players').tap()
    assert.equal(await page.evaluate(() => window.__touches), 1)
    const at = Date.now()
    await page.getByLabel('Search players').fill('Jalen')
    await page.waitForFunction(() => window.__perfLabSearch.some(row => row.query === 'Jalen' && row.ready), null, { timeout: 1500 })
    assert.notEqual(await page.evaluate(() => window.__savedSearch), 'Jalen')
    await settleControl(page, { kind: 'fill', label: 'Search players', keystrokes: [{ at, value: 'Jalen' }] })
    assert.equal(await page.evaluate(() => window.__savedSearch), 'Jalen')
    return 'Search warmup waits for debounce; visible-result negative control and iPhone standalone emulation pass'
  } finally { await browser.close() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await checkSearchObserver())
