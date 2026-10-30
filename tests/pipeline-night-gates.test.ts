import { describe, expect, it } from 'vitest'
import { assertEquivalent, comparePairs } from './db/pipeline-night-gates.mjs'

const quality = () => ({ values: [{ changed: 24 }], rows: { stats: [{ points: 20 }] }, followup: { pending: 5 }, freshness: 1200 })
const pairs = (before = 100, after = 50) => Array.from({ length: 5 }, (_, round) => [
  { phase: 'baseline', round, ms: before }, { phase: 'candidate', round, ms: after },
]).flat()

describe('frozen pipeline night gates', () => {
  it('accepts identical output, rows and follow-up work', () => expect(() => assertEquivalent(quality(), quality())).not.toThrow())
  it.each(['values', 'rows', 'followup'] as const)('rejects changed %s', field => {
    const after = quality()
    Object.assign(after, { [field]: {} })
    expect(() => assertEquivalent(quality(), after)).toThrow()
  })
  it('rejects worse live score freshness', () => expect(() => assertEquivalent(quality(), { ...quality(), freshness: 1199 })).toThrow('freshness'))
  it('keeps gains beyond the noise floor', () => expect(comparePairs(pairs()).keep).toBe(true))
  it('rejects a gain within ten percent', () => expect(comparePairs(pairs(100, 91)).keep).toBe(false))
  it('uses the baseline spread when larger', () => {
    const samples = pairs()
    samples[0].ms = 200
    expect(comparePairs(samples).keep).toBe(false)
  })
  it('rejects fewer than five pairs', () => expect(() => comparePairs(pairs().slice(2))).toThrow('Five'))
  it('rejects mismatched pairs', () => {
    const samples = pairs()
    samples[1].round = 9
    expect(() => comparePairs(samples)).toThrow('Pair missing')
  })
})
