import { expect, it } from 'vitest'
import { inventory } from '../../scripts/perf-lab/workloads.mjs'
import { expectedSurface } from '../../scripts/perf-lab/surfaces.mjs'
import { emptyPlan } from '../../scripts/perf-lab/empty.mjs'

it('declares the direct Analyzer tab in every role, day, and cache state', async () => {
  const work = await inventory()
  expect(work.surfaces.find((row: { id: string }) => row.id === 'trades.analyzer')).toMatchObject({ route: '/trades?tab=analyzer' })
  expect(work.rows.filter((row: { surface: string }) => row.surface === 'trades.analyzer')).toHaveLength(24)
})

it('requires Analyzer body content as well as the selected tab', () => {
  const contract = expectedSurface({ id: 'trades.analyzer' }, {}, 'member')
  expect(contract.all[0]).toEqual({ selector: '#trade-section-analyzer[aria-selected="true"]' })
  expect(JSON.stringify(contract.all[1])).toContain('Choose a team.')
  expect(JSON.stringify(contract.all[1])).toContain('Analyze with ')
})

it('exercises the empty Analyzer without changing league data', () => {
  expect(emptyPlan({ id: 'trades.analyzer' })).toEqual({ expected: { text: 'Choose a team.' }, tables: [] })
})
