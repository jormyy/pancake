import { expect, it } from 'vitest'
import { validateDatabaseWindow } from '../../scripts/season-sim/database-window-contract.mjs'

const window = { version: 1, days: 2, seasonYear: 2027, start: '2026-10-29', end: '2026-10-30', provenance: 'SYNTHETIC', games: 10 }
const lane = { NODE_ENV: 'test' as const, PERF_LAB_PROJECT: 'pt4bafableig', PERF_LAB_LANE: 'fable-l4c', PERF_LAB_PORT_PREFIX: '630' }

it('accepts the assigned private project and rejects another lane', () => {
  expect(validateDatabaseWindow(window, 'pt4bafableig', 2027, lane)).toBe(window)
  expect(() => validateDatabaseWindow(window, 'pt4bafablel4', 2027, lane)).toThrow('assigned private project')
})

it('keeps the legacy audit assignment when no private lab is configured', () => {
  expect(validateDatabaseWindow(window, 'pt4bafabledb', 2027, { NODE_ENV: 'test' })).toBe(window)
  expect(() => validateDatabaseWindow(window, 'pt4bafableig', 2027, { NODE_ENV: 'test' })).toThrow()
})

it('retains the exact two-day and season guards', () => {
  expect(() => validateDatabaseWindow({ ...window, days: 1 }, 'pt4bafableig', 2027, lane)).toThrow()
  expect(() => validateDatabaseWindow(window, 'pt4bafableig', 2026, lane)).toThrow()
})
