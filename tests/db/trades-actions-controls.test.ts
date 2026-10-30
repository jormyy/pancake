import { describe, expect, it } from 'vitest'
import { nestedPlans, aggregate, compareActionResults, paired } from './trades-actions-report.mjs'

describe('trade action measurement controls', () => {
  it('parses nested plans without treating braces in SQL strings as document boundaries', () => {
    const plan = { 'Query Text': 'SELECT \'{"x":"}"}\'', Plan: { 'Node Type': 'Result' } }
    const source = `NOTICE: duration: 1.25 ms plan:\n${JSON.stringify(plan, null, 2)}\nCONTEXT: SQL function\n`
    expect(nestedPlans(source)).toEqual([{ milliseconds: 1.25, ...plan }])
    expect(nestedPlans(source.slice(0, -45))).toEqual([])
  })

  it('rejects action summaries with fewer than five repetitions', () => {
    const row = { name: 'accept', variant: 'baseline', warm: false, metrics: { milliseconds: 1 } }
    expect(() => aggregate(Array.from({ length: 4 }, () => row))).toThrow('Five samples required')
  })

  it('fails on response whitespace and any persisted row change', () => {
    const baseline = { response: '{"ok":true}', rows: { 'public.trades': [{ status: 'accepted', notes: 'Terms' }] } }
    expect(() => compareActionResults(baseline, structuredClone(baseline))).not.toThrow()
    expect(() => compareActionResults(baseline, { ...baseline, response: '{ "ok":true}' })).toThrow('Action response bytes changed')
    const candidate = structuredClone(baseline)
    candidate.rows['public.trades'][0].notes = 'Other terms'
    expect(() => compareActionResults(baseline, candidate)).toThrow('Touched table rows changed')
  })

  it('pairs nearby runs and rejects an incomplete comparison', () => {
    const results = Array.from({ length: 5 }, (_, round) => ['baseline', 'candidate'].map(variant => ({
      name: 'accept', manager: 0, warm: true, variant, round,
      metrics: { milliseconds: 50 + round * 1000 - (variant === 'candidate' ? 20 : 0), statements: 10, hits: 20, reads: 0, wal: 0, bytes: 10 },
    }))).flat()
    expect(paired(results)[0].pairedDifferenceP50).toBe(-20)
    expect(paired(results)[0].load.buffers.gain).toBe(false)
    expect(() => paired(results.slice(1))).toThrow('Incomplete comparison pair')
  })
})
