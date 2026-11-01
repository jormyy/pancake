import { expect, it, vi } from 'vitest'
import { isolatedPhases } from '../../scripts/perf-lab/run.mjs'

it('finishes and preserves the screen workload before starting a separate replay restore', async () => {
  const completed: string[] = []
  const execute = vi.fn(async (mode: string) => { completed.push(mode); return mode === 'walk' ? 1 : 0 })
  expect(await isolatedPhases(35, execute)).toBe(1)
  expect(completed).toEqual(['walk', 'replay'])
  expect(execute.mock.calls).toEqual([
    ['walk', 35, { writeReports: false }],
    ['replay', undefined, { skipSync: true }],
  ])
})

it('does not start another stack after an incomplete screen cleanup', async () => {
  const execute = vi.fn(async () => { throw new Error('cleanup incomplete') })
  await expect(isolatedPhases(35, execute)).rejects.toThrow('cleanup incomplete')
  expect(execute).toHaveBeenCalledOnce()
})
