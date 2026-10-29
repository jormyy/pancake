import { expect, it } from 'vitest'
import { screenBaseline, screenBaselineLines } from '../../scripts/perf-lab/screen-baseline.mjs'

const surfaces = [{ id: 'players', route: '/players' }, { id: 'trades', route: '/trades' }, { id: 'interaction.search', route: '/players', scenario: 'search' }]
const observation = (surface: string, state: string, bytes: number, passed = true) => ({ surface, state, id: `${surface}/member/final/${state}`, source: 'a'.repeat(40), evidence: '/evidence/test', role: 'member', day: 'final', webkit: { passed, requests: bytes ? 2 : 0, bytesIn: bytes, bytesOut: 0, firstContentMs: 50, settledMs: 80 } })

it('ranks one successful sample per screen and state without adding interactions', () => {
  const rows = screenBaseline(surfaces, [observation('players', 'cold', 100), observation('players', 'warm', 10), observation('players', 'offline', 0), observation('trades', 'cold', 200), observation('interaction.search', 'cold', 1000)])
  expect(rows.map((row: { surface: string }) => row.surface)).toEqual(['trades', 'players'])
  expect(rows[1]).toMatchObject({ costTimesFrequencyBytes: 110, complete: true, states: { offline: { requests: 0, bytesDown: 0 } } })
  expect(rows[0].states.warm).toBe(null)
  expect(rows[0].complete).toBe(false)
  expect(screenBaselineLines(rows).join('\n')).toContain('| /players (players) | 2 / 100 / 0 / 50 / 80 | 2 / 10 / 0 / 50 / 80 | 0 / 0 / 0 / 50 / 80 | 110 |')
})

it('retains before samples when a newer attempt fails and selects a newer successful capture', () => {
  const rows = screenBaseline(surfaces, [observation('players', 'cold', 100), observation('players', 'cold', 900, false), observation('players', 'warm', 20), observation('players', 'warm', 10)])
  expect(rows.find((row: { surface: string }) => row.surface === 'players')).toMatchObject({ states: { cold: { bytesDown: 100 }, warm: { bytesDown: 10 } } })
})
