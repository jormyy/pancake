import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { configureClockCapture } from '../../scripts/perf-lab/clock-capture.mjs'

it.each(['0', '25ms'])('suppresses synthetic clock plans while preserving the configured %s plan threshold', async plans => {
  const directory = await mkdtemp(path.join(tmpdir(), 'clock-capture-'))
  const commands: string[] = []
  const state = { clock: '2025-10-22T10:00:00Z', rate: 0, plans, statements: 'all', virtualFunctions: 5, suppressedFunctions: 0 }
  const execute = async (query: string) => {
    commands.push(query)
    if (query.startsWith('ALTER')) { state.suppressedFunctions = 5; return '' }
    return JSON.stringify(state)
  }
  try {
    const result = await configureClockCapture(directory, execute, async () => {})
    expect(result.before.clock).toBe(result.after.clock)
    expect(result.after).toMatchObject({ plans, statements: 'all', suppressedFunctions: 5 })
    expect(commands[1].split('\n')).toHaveLength(5)
    expect(commands[1]).not.toMatch(/ALTER (SYSTEM|DATABASE|ROLE)|public\./)
    state.virtualFunctions = 4
    await expect(configureClockCapture(directory, execute, async () => {})).rejects.toThrow('Only installed virtual-clock')
    expect(commands.filter(query => query.startsWith('ALTER'))).toHaveLength(1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
