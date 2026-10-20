import assert from 'node:assert/strict'
import { test } from 'vitest'
import { captureFacts, combinedMetrics, compareCells, summarizeCells } from './layout-stability-analysis.mjs'

const row = (engine: string, metrics?: object) => ({ surface: 'home', target: engine, scenario: 'refresh', latencyProfile: 'slow', engine, status: metrics ? 'FAIL' : 'NOT_RUN', metrics })
const metrics = { maxHorizontalPx: 0, maxVerticalPx: 8, cls: 'unsupported', blankFrames: 3, blankDurationMs: 50, loadingDurationMs: 0, spinnerDurationMs: 600, reappearances: 1 }

test('unmeasured and unsupported measurements never become zero', () => {
  assert.equal(summarizeCells([row('webkit')]).maxVerticalPx, null)
  assert.equal(summarizeCells([row('webkit', metrics)]).maxChromiumCls, null)
  assert.equal(summarizeCells([row('webkit', metrics)]).webkitCls, 'unsupported')
})

test('comparison rejects missing combinations instead of treating them as passes', () => {
  assert.throws(() => compareCells([row('webkit', metrics)], [], 'surface'), /same cells/)
})

test('blank frame totals exclude timer samples and preserve the affected route', () => {
  const facts = captureFacts({ began: 0, metrics, frames: [
    { t: 100, route: '/', source: 'animation-frame', blank: true },
    { t: 110, route: '/', source: 'timer', blank: true },
    { t: 120, route: '/players', source: 'animation-frame', blank: false },
  ], moves: [{ t: 119.999, dx: 0, dy: 8, selector: '#row', text: 'Player', previousRect: { x: 0, y: 0 }, currentRect: { x: 0, y: 8 } }] })
  assert.equal(facts.blankRoutes[0].frames, 1)
  assert.equal(facts.blankRoutes[0].durationMs, 20)
  assert.equal(facts.moves[0].route, '/players')
})

test('history comparisons retain separate documents and count repeated frame prefixes once', () => {
  const frames = [{ t: 10, route: '/', source: 'animation-frame' }, { t: 20, route: '/', source: 'animation-frame' }]
  const first = { began: 0, frames: frames.slice(0, 1), metrics: { ...metrics, blankFrames: 1 } }
  const final = { began: 0, frames, metrics: { ...metrics, blankFrames: 2 } }
  assert.equal(combinedMetrics({ final, first }).blankFrames, 2)
  const other = { began: 50, frames, metrics: { ...metrics, maxVerticalPx: 100 } }
  const combined = combinedMetrics({ final, other })
  assert.equal(combined.blankFrames, 5)
  assert.equal(combined.spinnerDurationMs, 1200)
  assert.equal(combined.maxVerticalPx, 100)
  assert.equal(combined.cls, 'unsupported')
})

test('visible return movements remain explicit when an element returns to its original baseline', () => {
  const facts = captureFacts({ metrics, frames: [
    { t: 100, route: '/', source: 'animation-frame', visibility: 'hidden' },
    { t: 200, route: '/', source: 'animation-frame', visibility: 'visible' },
  ], moves: [
    { t: 100, dx: 0, dy: 21, selector: '#row', text: 'Budget', previousRect: { x: 0, y: 0 }, currentRect: { x: 0, y: 21 } },
    { t: 200, dx: 0, dy: 0, selector: '#row', text: 'Budget', previousRect: { x: 0, y: 21 }, currentRect: { x: 0, y: 0 } },
  ] })
  assert.equal(facts.moves[0].visibility, 'visible')
  assert.equal(facts.moves[0].stepDy, 21)
  assert.equal(facts.hiddenMoves.length, 1)
})
