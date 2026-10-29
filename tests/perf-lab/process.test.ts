import { expect, it } from 'vitest'
import { command } from '../../scripts/perf-lab/process.mjs'

it('allows a zero-cutoff command to finish instead of killing it immediately', async () => {
  await expect(command(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("finished"), 30)'], { timeout: 0 })).resolves.toMatchObject({ code: 0, stdout: 'finished' })
})

it('keeps explicit short command timeouts enforced', async () => {
  await expect(command(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeout: 10 })).rejects.toThrow('timed out')
})
