import { describe, expect, it } from 'vitest'
import { scenarios } from './roster-actions-cases.mjs'
import { compare, pairedTime, summary } from './roster-actions-report.mjs'

describe('roster action cost gate', () => {
  const samples = (values: number[]) => values.map(ms => ({ ms, buffers: ms, wal: ms, statements: ms, rowsWritten: 1, responseBytes: 2, triggerCalls: 1, versionMs: 0, refreshMs: 0, notificationMs: 0 }))
  it('rejects improvements inside baseline spread', () => {
    const result = compare(summary(samples([90, 100, 100, 100, 110])), summary(samples([85, 85, 85, 85, 85])))
    expect(result.ms.threshold).toBe(0.2)
    expect(result.ms.passes).toBe(false)
  })
  it('requires a gain beyond ten percent on stable samples', () => {
    const baseline = summary(samples([100, 100, 100, 100, 100]))
    expect(compare(baseline, summary(samples([91, 91, 91, 91, 91]))).ms.passes).toBe(false)
    expect(compare(baseline, summary(samples([80, 80, 80, 80, 80]))).ms.passes).toBe(true)
  })
  it('requires five samples', () => {
    expect(() => compare(summary(samples([100, 100, 100, 100])), summary(samples([50, 50, 50, 50, 50])))).toThrow()
  })
  it('uses interleaved paired timing and rejects noisy differences', () => {
    const pairs = (before: number[], after: number[]) => before.flatMap((ms, round) => [
      { name: 'drop', manager: 1, phase: 'warm', round, variant: 'baseline', ms },
      { name: 'drop', manager: 1, phase: 'warm', round, variant: 'candidate', ms: after[round] },
    ])
    expect(pairedTime(pairs([100, 200, 300, 400, 500], [80, 160, 240, 320, 400])).passes).toBe(true)
    expect(pairedTime(pairs([100, 100, 100, 100, 100], [50, 80, 80, 80, 110])).passes).toBe(false)
    expect(() => pairedTime(pairs([100, 100], [50, 50]))).toThrow()
  })
  it('covers every action for each of three managers', () => {
    const cases = [1, 2, 3].map(scenarios)
    for (const rows of cases) {
      expect(rows.map(row => row.name)).toEqual(cases[0].map(row => row.name))
      for (const name of ['add-active', 'add-ir', 'add-taxi', 'drop', 'drop-and-add', 'claim-submit-rolling', 'claim-edit-faab', 'claim-cancel-faab', 'claim-reorder-faab', 'faab-zero-bid', 'worker-faab-tie', 'from-ir', 'from-taxi', 'activate-ir-lineup-drop', 'activate-taxi-overflow-ir', 'commissioner-faab', 'commissioner-weekly-add', 'invite-join', 'trade-pending-drop', 'trade-pending-ir', 'trade-pending-taxi', 'locked-activation']) expect(rows.some(row => row.name === name)).toBe(true)
    }
  })
})
