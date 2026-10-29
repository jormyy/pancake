import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { expectContent, performAction } from '../../scripts/perf-lab/actions.mjs'
import { settleControl } from '../../scripts/perf-lab/settle.mjs'

const browser = await webkit.launch({ headless: true })
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(600)
  const failures = []
  for (const [name, check] of [
    ['visible duplicate text', async () => {
      await page.setContent('<h1 hidden>Fixture player</h1><main>Fixture player</main>')
      await expectContent(page, { text: 'Fixture player' }, page.url())
    }],
    ['modal duplicate button', async () => {
      await page.setContent('<button aria-label="Sign out" onclick="window.choice=1">Sign out</button><div role="dialog" aria-label="Confirm" style="position:fixed;inset:0;background:white"><button aria-label="Sign out" onclick="window.choice=2">Sign out</button></div>')
      await performAction(page, page.context(), 'http://localhost', { tap: 'Sign out' })
      assert.equal(await page.evaluate(() => window.choice), 2)
    }],
    ['continuing background traffic', async () => {
      await page.route('http://127.0.0.1:57284/probe', async route => {
        await new Promise(resolve => setTimeout(resolve, 200))
        await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' })
      })
      await page.setContent('<script>window.probe=setInterval(()=>fetch("http://127.0.0.1:57284/probe").catch(()=>{}),100)</script><main>Ready</main>')
      await page.waitForTimeout(250)
      await settleControl(page, { kind: 'tap', label: 'Open details' })
      await page.evaluate(() => clearInterval(window.probe))
    }],
  ]) {
    try { await check(); console.log(`${name}: pass`) }
    catch (error) { failures.push(name); console.log(`${name}: fail: ${error.message.split('\n')[0]}`) }
  }
  assert.deepEqual(failures, [])
} finally { await browser.close() }
