import { afterEach, expect, it, vi } from 'vitest'
import { command } from '../../scripts/perf-lab/process.mjs'
import { run } from '../../scripts/perf-lab/run.mjs'

vi.mock('../../scripts/perf-lab/process.mjs', () => ({ command: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

it('gives an 1800-second replay time to finish setup and cleanup', async () => {
  vi.stubEnv('PERF_LAB_SECONDS', '1800')
  let timeout = 0
  vi.mocked(command).mockImplementation(async (file, args, options) => {
    if (file === 'ssh' && args?.at(-1)?.includes('node scripts/perf-lab/mini.mjs replay')) {
      timeout = (options as { timeout?: number } | undefined)?.timeout ?? 0
      throw new Error('recorded replay launch')
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  await expect(run('replay')).rejects.toThrow('recorded replay launch')
  expect(timeout).toBeGreaterThanOrEqual(2400000)
})

it('keeps an unlimited replay free of a hidden SSH wall cutoff', async () => {
  vi.stubEnv('PERF_LAB_SECONDS', '0')
  let timeout = -1
  vi.mocked(command).mockImplementation(async (file, args, options) => {
    if (file === 'ssh' && args?.at(-1)?.includes('node scripts/perf-lab/mini.mjs replay')) {
      timeout = (options as { timeout?: number } | undefined)?.timeout ?? -1
      throw new Error('recorded replay launch')
    }
    return { code: 0, stdout: '', stderr: '' }
  })
  await expect(run('replay')).rejects.toThrow('recorded replay launch')
  expect(timeout).toBe(0)
})
