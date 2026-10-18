import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
const failures = []
for (const engine of ['chromium', 'webkit']) {
  const samples = report.samples.filter(sample => sample.engine === engine)
  assert.equal(samples.length, 3, `${engine}: three persistent profiles required`)
  for (const sample of samples) {
    if (sample.error || sample.errors.length || !sample.offlineSignIn) failures.push({ engine, sample: sample.sample, reason: 'incomplete or failed sample' })
    const cold = sample.segments.find(segment => segment.mode === 'cold')
    const warm = sample.segments.find(segment => segment.mode === 'warm')
    if (!cold || cold.bodyBytes >= 1000000) failures.push({ engine, sample: sample.sample, reason: 'cold transfer', bytes: cold?.bodyBytes })
    if (!warm || warm.responses.some(response => response.path !== '/sw.js')) failures.push({ engine, sample: sample.sample, reason: 'warm delivery downloads' })
    if (cold?.repeatedAssets.some(([url]) => /manifest|\/pwa-|\/assets\/pwa\//.test(url))) failures.push({ engine, sample: sample.sample, reason: 'duplicate boot delivery' })
  }
}
console.log(JSON.stringify({ passed: failures.length === 0, failures }))
assert.equal(failures.length, 0, 'First-load delivery budget failed')
