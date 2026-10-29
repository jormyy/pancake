import { expect, it } from 'vitest'
import { labTarget } from '../../scripts/perf-lab/target.mjs'

it('keeps an integration lab inside its assigned folder and port block', () => {
  expect(labTarget({ ...process.env, PERF_LAB_LANE: 'fable-r27', PERF_LAB_PROJECT: 'pt4bafabler27', PERF_LAB_PORT_PREFIX: '600' })).toMatchObject({
    lane: 'fable-r27', relativeRoot: 'pancake-t_4ba51e0d/lanes/fable-r27', project: 'pt4bafabler27', prefix: '600',
    ports: { api: 60021, db: 60022, edge: 60081, https: 60084, proxy: 60088 },
  })
})

it.each([
  { PERF_LAB_LANE: '../shared' }, { PERF_LAB_LANE: '/tmp/lab' }, { PERF_LAB_LANE: 'lab;exit' },
  { PERF_LAB_PROJECT: 'ceeytbfmwsnzalxlkalc' }, { PERF_LAB_PROJECT: 'ptlocal;exit' },
  { PERF_LAB_PORT_PREFIX: '999' }, { PERF_LAB_PORT_PREFIX: '0' }, { PERF_LAB_PORT_PREFIX: '600;exit' },
])('rejects unsafe lab overrides: %j', env => {
  expect(() => labTarget({ ...process.env, ...env })).toThrow()
})
