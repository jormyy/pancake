import { expect, it } from 'vitest'
import { selectedSurfaces, workloadSelection } from '../../scripts/perf-lab/selection.mjs'

it('excludes unrelated fixture setup and phases before starting a selected screen', () => {
  const work = {
    surfaces: [{ id: 'wanted' }, { id: 'unrelated', scenario: 'taxi' }],
    rows: [
      { id: 'wanted/member/final/cold', surface: 'wanted', role: 'member', day: 'final', state: 'cold' },
      { id: 'unrelated/commissioner/in-progress/cold', surface: 'unrelated', role: 'commissioner', day: 'in-progress', state: 'cold' },
    ],
  }
  const selected = workloadSelection({ NODE_ENV: 'test', PERF_LAB_CASES: 'wanted/member/final/cold' })
  expect(selectedSurfaces(work, selected)).toEqual([work.surfaces[0]])
  expect(selectedSurfaces(work, selected, { role: 'commissioner', day: 'in-progress' })).toEqual([])
  expect(selectedSurfaces(work, selected, { role: 'member', day: 'final' })).toEqual([work.surfaces[0]])
})
