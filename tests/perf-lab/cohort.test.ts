import { expect, it } from 'vitest'
import { captureCohort } from '../../scripts/perf-lab/cohort.mjs'

const sample = (id: string, bytes: number, passed = true) => ({ id, state: 'cold', webkit: { passed, requests: 1, bytesIn: bytes, bytesOut: 0, traffic: {
  resourceTypes: [{ id: 'JavaScript', requests: 1, bytesDown: bytes, bytesUp: 0, durationMs: 10 }],
  endpoints: [{ id: 'GET /entry.js', requests: 1, bytesDown: bytes, bytesUp: 0, durationMs: 10 }],
} } })

it('ranks each successful workload once and retains the evidence that supplies its number', () => {
  const cohort = captureCohort({ release: 'candidate', sources: ['before', 'after'] }, [
    { source: 'unrelated', observations: [sample('foreign', 9000)] },
    { source: 'before', evidence: 'old', observations: [sample('screen', 100), sample('other', 30)] },
    { source: 'after', evidence: 'new', observations: [sample('screen', 50), sample('failed', 700, false)] },
  ])
  expect(cohort.observations.map((row: { id: string; source: string; evidence: string }) => [row.id, row.source, row.evidence])).toEqual([
    ['screen', 'after', 'new'], ['other', 'before', 'old'],
  ])
  expect(cohort.ranking.resourceTypes).toEqual([{ id: 'JavaScript', requests: 2, bytesDown: 80, bytesUp: 0, durationMs: 20, bytesPerRequest: 40 }])
  expect(cohort.states).toEqual([{ state: 'cold', samples: 2, requests: 2, bytesDown: 80, bytesUp: 0 }])
})
