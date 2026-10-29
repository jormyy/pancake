import { expect, it } from 'vitest'
import { enforceReplay, summarizeReplay } from './db/forecast-costs.mjs'

function fixture(before = 600, after = 10) {
  return Array.from({ length: 5 }, (_, round) => ['baseline', 'candidate'].flatMap(phase => ['idle', 'live'].map(profile => ({
    round, phase, profile, businessMinutes: profile === 'idle' ? 60 : 30,
    samples: [{ kind: 'context', milliseconds: phase === 'baseline' ? before : after, buffers: 100 }],
    completions: profile === 'idle' ? [] : [{ id: 'matchup', tick: 1, forecastHash: 'unchanged', milliseconds: phase === 'baseline' ? 50 : 10 }],
    stats: [],
  })))).flat()
}

it('accepts five paired gains with forecast parity and faster live completion', () => {
  expect(enforceReplay(fixture())).toHaveLength(20)
})

it('rejects an undersampled comparison', () => {
  expect(() => enforceReplay(fixture().filter(row => row.round < 4))).toThrow('Five paired runs')
})

it('rejects duplicate replay cases after resuming a checkpoint', () => {
  const runs = fixture()
  runs.push({ ...runs[0] })
  expect(() => enforceReplay(runs)).toThrow('counted twice')
})

it('rejects a gain below the noise floor', () => {
  expect(() => enforceReplay(fixture(100, 95))).toThrow('DB gain is within noise')
})

it('rejects changed live forecast output', () => {
  const runs = fixture()
  runs.find(row => row.phase === 'candidate' && row.profile === 'live')!.completions[0].forecastHash = 'changed'
  expect(() => enforceReplay(runs)).toThrow('Live forecast parity')
})

it('rejects a duplicate computation in one tick', () => {
  const runs = fixture()
  const row = runs.find(row => row.phase === 'candidate' && row.profile === 'live')!
  row.completions.push({ ...row.completions[0] })
  expect(() => enforceReplay(runs)).toThrow('computed twice')
})

it('rejects worse due-to-done latency', () => {
  const runs = fixture()
  runs.find(row => row.phase === 'candidate' && row.profile === 'live')!.completions[0].milliseconds = 51
  expect(() => enforceReplay(runs)).toThrow('due-to-done p95 regressed')
})

it('reports calls and database time per hour', () => {
  const summary = summarizeReplay(fixture())
  expect(summary.find((row: { phase: string; profile: string }) => row.phase === 'baseline' && row.profile === 'live')).toMatchObject({ forecastDbMsPerHour: 1200, callsPerHour: { context: 2 } })
  expect(summary.find((row: { phase: string; profile: string }) => row.phase === 'baseline' && row.profile === 'idle')).toMatchObject({ forecastDbMsPerHour: 600, callsPerHour: { context: 1 } })
})
