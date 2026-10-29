import { expect, it } from 'vitest'
import { clockRuntime, replayRuntime } from '../../scripts/perf-lab/replay-runtime.mjs'

it('separates overlapping worker duration from elapsed time and matches the business cutoff', () => {
  const rows = [
    { function: 'first', at: '2025-10-23T02:00:00Z', realAt: '2026-10-28T12:00:10Z', durationMs: 10000, status: 200 },
    { function: 'second', at: '2025-10-23T02:15:00Z', realAt: '2026-10-28T12:00:10Z', durationMs: 6000, status: 500 },
    { function: 'third', at: '2025-10-23T02:20:00Z', realAt: '2026-10-28T12:00:20Z', durationMs: 2000, status: 200 },
  ]
  expect(replayRuntime(rows, '2025-10-23T02:15:00Z')).toMatchObject({ calls: 2, spanMs: 10000, durationMs: 16000, errors: 1 })
  expect(replayRuntime(rows)?.calls).toBe(3)
  expect(replayRuntime([])).toBe(null)
  expect(() => replayRuntime(rows, 'invalid')).toThrow('cutoff')
})

it('compares the clock mean across full captures without adding nested clock time twice', () => {
  const transaction = { queryid: '1', query: 'SELECT season_sim.time(season_sim.real_transaction())', calls: 1000, total_exec_time: 22, rows_returned_or_affected: 1000, shared_blks_hit: 1000, shared_blks_read: 0 }
  const nested = { ...transaction, queryid: '2', query: 'SELECT to_timestamp(sim_ms) FROM season_sim.clock WHERE singleton', total_exec_time: 3 }
  expect(clockRuntime({ byTotal: [transaction, nested], byMean: [transaction] })).toEqual([
    { clock: 'transaction', calls: 1000, durationMs: 22, meanMs: 0.022, normalized200Ms: 4.4, rows: 1000, buffers: 1000 },
    { clock: 'table', calls: 1000, durationMs: 3, meanMs: 0.003, normalized200Ms: 0.6, rows: 1000, buffers: 1000 },
  ])
  expect(clockRuntime(null)).toEqual([])
})
