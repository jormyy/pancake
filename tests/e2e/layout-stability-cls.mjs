import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { layoutShiftSessionScore } from './web-targets-geometry.mjs'
import { saveSweepReport } from './layout-stability-report.mjs'

const argument = process.argv.slice(2).find((arg) => arg.startsWith('--output-dir='))
assert.ok(argument, 'Use --output-dir=/absolute/evidence/directory')
const output = path.resolve(argument.slice('--output-dir='.length))
assert.ok(output !== process.cwd() && !output.startsWith(`${process.cwd()}/`), 'Evidence must be outside the checkout')
const digest = createHash('sha256').update(layoutShiftSessionScore.toString()).digest('hex')
for (const name of ['sweep', 'notice-navigation']) {
  const report = JSON.parse(await readFile(path.join(output, `${name}.json`), 'utf8'))
  let changed = 0
  let checked = 0
  for (const row of report.cells) {
    if (row.support?.cls !== 'supported' || !row.metrics) continue
    const relative = row.evidence ?? path.join(row.target, row.latencyProfile, row.surface, `${row.scenario}-error.json`)
    const evidencePath = path.resolve(output, relative)
    assert.ok(evidencePath.startsWith(`${output}/`), 'Evidence path escapes the output directory')
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    const capture = evidence.capture ?? evidence
    const captures = { main: capture, ...evidence.additionalCaptures }
    for (const detail of Object.values(captures)) {
      assert.ok(Array.isArray(detail.shifts), 'Raw LayoutShift entries are required')
      detail.metrics.cls = layoutShiftSessionScore(detail.shifts)
    }
    checked++
    if (row.metrics.cls !== capture.metrics.cls) changed++
    row.metrics.cls = capture.metrics.cls
    row.failures = row.failures?.map((failure) => {
      if (failure.startsWith('CLS ')) return `CLS ${capture.metrics.cls}`
      for (const [key, detail] of Object.entries(evidence.additionalCaptures ?? {})) if (failure.startsWith(`${key}: CLS `)) return `${key}: CLS ${detail.metrics.cls}`
      return failure
    })
    await writeFile(evidencePath, JSON.stringify(evidence))
  }
  report.clsCalculation = { digest, checked, changed, rule: 'First shift starts the window; gap < 1000 ms; duration <= 5000 ms; excludes hadRecentInput', source: 'Saved raw LayoutShift entries', command: process.argv.join(' ') }
  await saveSweepReport(report, output, name)
  process.stdout.write(`${name}: checked ${checked} Chromium cells; corrected ${changed} CLS values\n`)
}
