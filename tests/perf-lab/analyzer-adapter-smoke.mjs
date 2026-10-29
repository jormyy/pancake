import assert from 'node:assert/strict'
import { webkit } from 'playwright'
import { readFile } from 'node:fs/promises'
import { currentScenario } from '../../scripts/perf-lab/scenario-adapters.mjs'
import { performAction, expectContent } from '../../scripts/perf-lab/actions.mjs'
import { phoneProfile } from '../../scripts/perf-lab/device.mjs'

const source = JSON.parse(await readFile(new URL('../../scripts/ios-sim/scenarios/trade-offline.json', import.meta.url), 'utf8')).find(row => row.name === 'trades-analyzer-offline-light')
const fixture = `<main id="root"><button id="trade-section-offers" onclick="offers()">Offers, 2</button><section id="panel"></section></main><script>
function offers() { document.getElementById('panel').innerHTML = '<button aria-label="Show details of trade with E2E Team 1">Details</button><button aria-label="Revalue trade from E2E Team 1 with current inputs" onclick="analysis()">Revalue</button>' }
function analysis() { document.getElementById('panel').innerHTML = '<section aria-label="Dynasty trade analysis">Saved analysis <button onclick="edit()">Edit assets</button></section>' }
function edit() { document.getElementById('panel').innerHTML = '<button aria-label="View trade analysis" onclick="result()">View analysis</button>' }
function result() { document.getElementById('panel').innerHTML = '<section aria-label="Dynasty trade analysis">Value 120 · Now 8 · Long 112</section>' }
offers()
</script>`
const browser = await webkit.launch({ headless: true })
try {
  const context = await browser.newContext(phoneProfile)
  const page = await context.newPage()
  page.setDefaultTimeout(750)
  await page.setContent(fixture)
  await assert.rejects(performAction(page, context, 'http://localhost', source.prepare[0]))
  await performAction(page, context, 'http://localhost', { tapPrefix: 'Revalue trade from ' })
  await assert.rejects(performAction(page, context, 'http://localhost', source.prepare[2]))
  const scenario = currentScenario(source)
  await page.setContent(fixture)
  for (const action of scenario.prepare) await performAction(page, context, 'http://localhost', action)
  for (const step of scenario.steps) {
    await performAction(page, context, 'http://localhost', step.action)
    const expected = { ...step.expected }
    delete expected.route
    await expectContent(page, expected, 'http://localhost')
  }
  console.log('WebKit rejects both obsolete labels and passes the adapted offline Analyzer sequence on an isolated UI fixture; application coverage remains unproved')
} finally { await browser.close() }
