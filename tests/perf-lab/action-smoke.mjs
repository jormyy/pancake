import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { performAction } from '../../scripts/perf-lab/actions.mjs'

export async function checkActionTargets() {
  const browser = await webkit.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    page.setDefaultTimeout(750)
    await page.setContent('<div aria-label="Close" style="position:fixed;inset:0" onclick="window.clicked=\'backdrop\'"></div><section style="position:fixed;inset:0;background:white"><button aria-label="Close" onclick="window.clicked=\'button\'">Close</button><div aria-label="Open fixture" onclick="window.opened=true">Open fixture</div></section>')
    await performAction(page, page.context(), 'http://localhost', { tap: 'Close' })
    assert.equal(await page.evaluate(() => window.clicked), 'button')
    await performAction(page, page.context(), 'http://localhost', { tapPrefix: 'Open ' })
    assert.equal(await page.evaluate(() => window.opened), true)
    await page.setContent('<section role="dialog" aria-label="Filters"></section>')
    await page.evaluate(() => setTimeout(() => {
      const button = document.createElement('button')
      button.textContent = 'Show 20 filtered players'
      button.onclick = () => { window.selectedFilter = true }
      document.querySelector('section').append(button)
    }, 100))
    await performAction(page, page.context(), 'http://localhost', { tapPrefix: 'Show ', dialog: 'Filters' })
    assert.equal(await page.evaluate(() => window.selectedFilter), true)
    return 'Labeled actions preserve button priority, plain-label support, and delayed text-only controls'
  } finally { await browser.close() }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await checkActionTargets())
