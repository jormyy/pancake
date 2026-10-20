import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const cellKey = (row) => [row.surface, row.target, row.scenario, row.latencyProfile].join('|')

export function combinedMetrics(captures) {
  const values = Object.values(captures)
  const distinct = values.filter((capture, index) => !values.some((other, otherIndex) => otherIndex !== index &&
    other.began === capture.began && other.frames.length >= capture.frames.length &&
    (other.frames.length > capture.frames.length || otherIndex < index) &&
    capture.frames.every((frame, frameIndex) => {
      const candidate = other.frames[frameIndex]
      return candidate.t === frame.t && candidate.route === frame.route && candidate.source === frame.source
    })))
  const metrics = distinct.map((capture) => capture.metrics)
  const cls = metrics.flatMap((item) => typeof item.cls === 'number' ? [item.cls] : [])
  return { ...values[0].metrics,
    cls: cls.length ? Math.max(...cls) : 'unsupported',
    maxHorizontalPx: Math.max(...metrics.map((item) => item.maxHorizontalPx)),
    maxVerticalPx: Math.max(...metrics.map((item) => item.maxVerticalPx)),
    ...Object.fromEntries(['blankFrames', 'blankDurationMs', 'loadingDurationMs', 'spinnerDurationMs', 'reappearances']
      .map((key) => [key, metrics.reduce((sum, item) => sum + item[key], 0)])),
  }
}

export function summarizeCells(rows) {
  const measured = rows.filter((row) => row.metrics)
  const maximum = (values) => values.length ? Math.max(...values) : null
  const chromium = measured.filter((row) => row.engine === 'chromium' && typeof row.metrics.cls === 'number')
  return {
    cells: rows.length,
    measured: measured.length,
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    notRun: rows.filter((row) => row.status === 'NOT_RUN').length,
    maxHorizontalPx: maximum(measured.map((row) => row.metrics.maxHorizontalPx)),
    maxVerticalPx: maximum(measured.map((row) => row.metrics.maxVerticalPx)),
    maxChromiumCls: maximum(chromium.map((row) => row.metrics.cls)),
    webkitCls: rows.some((row) => row.engine === 'webkit') ? 'unsupported' : 'not applicable',
    blankFrames: measured.length ? measured.reduce((sum, row) => sum + row.metrics.blankFrames, 0) : null,
    blankHits: measured.filter((row) => row.metrics.blankFrames > 0).length,
    loadingHits: measured.filter((row) => row.metrics.loadingDurationMs > 0).length,
    spinnerHits: measured.filter((row) => row.metrics.spinnerDurationMs > 0).length,
  }
}

export function compareCells(before, after, dimension) {
  assert.deepEqual([...before.map(cellKey)].sort(), [...after.map(cellKey)].sort(), 'Comparison requires the same cells on both builds')
  return [...new Set(before.map((row) => row[dimension]))].map((key) => ({
    [dimension]: key,
    before: summarizeCells(before.filter((row) => row[dimension] === key)),
    after: summarizeCells(after.filter((row) => row[dimension] === key)),
  }))
}

const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()]

export function captureFacts(capture) {
  const frames = capture.frames ?? []
  const frameAt = (t) => {
    let low = 0
    let high = frames.length - 1
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (frames[mid].t < t) low = mid + 1
      else high = mid
    }
    const next = frames[low]
    const previous = frames[low - 1]
    return previous && (!next || Math.abs(previous.t - t) < Math.abs(next.t - t)) ? previous : next
  }
  const routeAt = (t) => frameAt(t)?.route ?? 'unknown'
  const visibilityAt = (t) => frameAt(t)?.visibility ?? 'unknown'
  const blankRoutes = [...new Set(frames.filter((frame) => frame.blank).map((frame) => frame.route))].map((route) => {
    const blank = frames.filter((frame) => frame.route === route && frame.blank)
    return { route, frames: blank.filter((frame) => frame.source === 'animation-frame').length,
      firstMs: blank[0]?.t - capture.began,
      durationMs: frames.reduce((sum, frame, index) => sum + (frame.blank && frame.route === route && frames[index + 1] ? frames[index + 1].t - frame.t : 0), 0) }
  })
  const loading = unique(frames.flatMap((frame) => (frame.loading ?? []).map((item) => ({ ...item, route: frame.route }))), (item) => `${item.route}|${item.selector}|${item.text}`)
  const spinners = unique(frames.flatMap((frame) => (frame.spinners ?? []).map((selector) => ({ selector, route: frame.route }))), (item) => `${item.route}|${item.selector}`)
  const movement = (capture.moves ?? []).map((move) => ({ ...move, route: routeAt(move.t), visibility: visibilityAt(move.t),
    stepDx: Math.abs(move.currentRect.x - move.previousRect.x), stepDy: Math.abs(move.currentRect.y - move.previousRect.y) }))
    .filter((move) => Math.max(move.dx, move.dy, move.stepDx, move.stepDy) > 2)
    .sort((a, b) => Math.max(b.dx, b.dy, b.stepDx, b.stepDy) - Math.max(a.dx, a.dy, a.stepDx, a.stepDy))
  const moveKey = (move) => `${move.route}|${move.selector}|${move.text}`
  const moves = unique(movement.filter((move) => move.visibility !== 'hidden'), moveKey)
  const hiddenMoves = unique(movement.filter((move) => move.visibility === 'hidden'), moveKey)
  const reappearances = unique((capture.reappearances ?? []).map((item) => ({ ...item, route: routeAt(item.t), visibility: visibilityAt(item.t) })), (item) => `${item.route}|${item.selector}|${item.text}|${item.visibility}`)
  const shifts = (capture.shifts ?? []).filter((shift) => !shift.hadRecentInput).map((shift) => ({ ...shift, route: routeAt(shift.t), visibility: visibilityAt(shift.t) }))
  return { metrics: capture.metrics, observation: capture.observation, support: capture.support,
    firstContentfulPaintAt: capture.firstContentfulPaintAt,
    blankRoutes, loading, spinners, moves: moves.slice(0, 15), hiddenMoves: hiddenMoves.slice(0, 15), reappearances: reappearances.slice(0, 25),
    shifts: shifts.sort((a, b) => b.value - a.value).slice(0, 10),
    movementRecordsCapped: (capture.moves?.length ?? 0) >= 2000, truncated: capture.truncated,
    events: capture.events, maxSampleGapMs: capture.metrics?.maxSampleGapMs }
}

const display = (value) => value === null ? 'unmeasured' : typeof value === 'number' ? Number(value.toFixed(6)) : value

function comparisonTable(rows, dimension) {
  return [
    `| ${dimension} | Build | Pass / fail / not run | Max sampled X / Y px | Max Chromium CLS | WebKit CLS | Blank frames (cells) | Loading / spinner cells |`,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.flatMap((row) => ['before', 'after'].map((build) => {
      const m = row[build]
      return `| ${row[dimension]} | ${build} | ${m.pass} / ${m.fail} / ${m.notRun} | ${display(m.maxHorizontalPx)} / ${display(m.maxVerticalPx)} | ${display(m.maxChromiumCls)} | ${m.webkitCls} | ${display(m.blankFrames)} (${m.blankHits}) | ${m.loadingHits} / ${m.spinnerHits} |`
    })), '',
  ]
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const split = arg.indexOf('=')
    return [arg.slice(2, split < 0 ? undefined : split), split < 0 ? true : arg.slice(split + 1)]
  }))
  if (args.help) {
    process.stdout.write('Usage: node tests/e2e/layout-stability-analysis.mjs --before-dir=PATH --after-dir=PATH --output-dir=PATH [--partial]\n')
    return
  }
  for (const key of ['before-dir', 'after-dir', 'output-dir']) assert.equal(typeof args[key], 'string', `Missing --${key}`)
  const output = path.resolve(/** @type {string} */ (args['output-dir']))
  assert.ok(output !== process.cwd() && !output.startsWith(`${process.cwd()}/`), 'Evidence must stay outside the checkout')
  const before = JSON.parse(await readFile(path.join(/** @type {string} */ (args['before-dir']), 'sweep.json'), 'utf8'))
  const after = JSON.parse(await readFile(path.join(/** @type {string} */ (args['after-dir']), 'sweep.json'), 'utf8'))
  if (!args.partial) {
    assert.ok(!after.error && !before.error, 'A run error requires review before comparison')
    assert.ok(after.cells.every((row) => row.reason !== 'Run has not reached this cell'), 'AFTER is still running')
  }
  const facts = []
  for (const [build, report] of [['before', before], ['after', after]]) for (const row of report.cells) {
    if (!row.metrics) {
      if (build === 'after' && row.status === 'FAIL') facts.push({ key: cellKey(row), ...row, captures: {} })
      continue
    }
    if (args.partial && (build === 'before' || row.status !== 'FAIL')) continue
    const evidencePath = row.evidence ?? path.join(row.target, row.latencyProfile, row.surface, `${row.scenario}-error.json`)
    const evidence = JSON.parse(await readFile(path.join(/** @type {string} */ (args[`${build}-dir`]), evidencePath), 'utf8'))
    const captures = { main: evidence.capture ?? evidence, ...evidence.additionalCaptures }
    if (!args.partial) row.metrics = combinedMetrics(captures)
    if (build === 'after' && row.status === 'FAIL') facts.push({ key: cellKey(row), ...row,
      captures: Object.fromEntries(Object.entries(captures).map(([name, capture]) => [name, captureFacts(capture)])) })
  }
  const comparison = { generatedAt: new Date().toISOString(), command: process.argv.join(' '), partial: !!args.partial,
    before: { release: before.release, harness: before.harness, command: before.command, reruns: before.reruns, clsCalculation: before.clsCalculation },
    after: { release: after.release, harness: after.harness, command: after.command, reruns: after.reruns, clsCalculation: after.clsCalculation },
    total: { before: summarizeCells(before.cells), after: summarizeCells(after.cells) },
    surfaces: compareCells(before.cells, after.cells, 'surface'), targets: compareCells(before.cells, after.cells, 'target') }
  await mkdir(output, { recursive: true })
  await writeFile(path.join(/** @type {string} */ (args['after-dir']), 'failure-facts.json'), JSON.stringify(facts, null, 2) + '\n')
  await writeFile(path.join(output, 'compare.json'), JSON.stringify(comparison, null, 2) + '\n')
  const lines = [
    '# Layout stability comparison', '',
    args.partial ? 'Provisional: AFTER is still running.' : 'Complete: every requested cell has a result or an explicit omission reason.', '',
    `BEFORE: ${before.release.commitSha}. AFTER: ${after.release.commitSha}.`, '',
    `Before: ${comparison.total.before.pass} pass, ${comparison.total.before.fail} fail, ${comparison.total.before.notRun} not run.`,
    `After: ${comparison.total.after.pass} pass, ${comparison.total.after.fail} fail, ${comparison.total.after.notRun} not run.`, '',
    args.partial ? 'Provisional tables use the main capture metrics.' : 'Tables include main and additional backward-navigation captures. Identical frame prefixes count once.',
    'Blank frames are summed across cells. Loading and spinner hits count cells with a positive visible duration.',
    'Different frame rates affect frame counts; inspect recorded durations before comparing perceived flicker length.',
    'WebKit CLS is unsupported. Geometry, blank frames, loading, spinners, and stability remain sampled metrics on both engines.', '',
    '## Per surface', '', ...comparisonTable(comparison.surfaces, 'surface'),
    '## Per target', '', ...comparisonTable(comparison.targets, 'target'),
  ]
  await writeFile(path.join(output, 'compare.md'), lines.join('\n'))
  process.stdout.write(JSON.stringify({ cells: after.cells.length, failuresExtracted: facts.length, after: comparison.total.after, output }) + '\n')
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
