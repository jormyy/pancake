import { afterEach, expect, it, vi } from 'vitest'
import { playerViewReady } from '../../scripts/perf-lab/player-results.mjs'
import { currentScenario } from '../../scripts/perf-lab/scenario-adapters.mjs'
import { inventory } from '../../scripts/perf-lab/workloads.mjs'

afterEach(() => vi.unstubAllGlobals())

const contract = { memberId: 'member', leagueId: 'league', params: { position: 'PG', query: '' } }

function fixture(names: string[], entries: unknown[], message = '') {
  const values = new Map(entries.map((entry, index) => [`pancake:screen-view:v1:${index}`, JSON.stringify(entry)]))
  vi.stubGlobal('window', { localStorage: { length: values.size, key: (index: number) => [...values.keys()][index], getItem: (key: string) => values.get(key) } })
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
  vi.stubGlobal('document', {
    querySelectorAll: () => names.map(name => ({ getClientRects: () => [{}], closest: () => ({ getAttribute: () => `Open ${name}` }) })),
    querySelector: () => ({ innerText: message }),
  })
}

function entry(names: string[], overrides = {}) {
  return { lookupScope: { screen: 'players', ...contract, ...overrides }, value: { players: names.map(display_name => ({ display_name })) } }
}

it('rejects unchanged results after the filter label changes', () => {
  fixture(['Old center'], [entry(['New guard'])])
  expect(playerViewReady(contract)).toBe(false)
})

it.each([{ memberId: 'other' }, { leagueId: 'other' }, { params: { position: 'C', query: '' } }])('rejects a matching name from the wrong request scope: %j', overrides => {
  fixture(['New guard'], [entry(['New guard'], overrides)])
  expect(playerViewReady(contract)).toBe(false)
})

it('accepts visible results from the requested filter response', () => {
  fixture(['New guard'], [entry(['New guard'])])
  expect(playerViewReady(contract)).toBe(true)
})

it('rejects the old sort order even when every displayed player belongs to the new response', () => {
  fixture(['Second guard', 'First guard'], [entry(['First guard', 'Second guard'])])
  expect(playerViewReady(contract)).toBe(false)
})

it('keeps distinct rows that share the same displayed name in their response order', () => {
  fixture(['Same name', 'Same name', 'Other name'], [entry(['Same name', 'Same name', 'Other name'])])
  expect(playerViewReady(contract)).toBe(true)
})

it('requires an empty response and the real empty list message', () => {
  fixture([], [entry([])])
  expect(playerViewReady(contract)).toBe(false)
  fixture([], [entry([])], 'No players match these filters')
  expect(playerViewReady(contract)).toBe(true)
})

it('requires a visible player from a subsequent page for infinite scroll', () => {
  const page = { ...contract, minOffset: 20 }
  fixture(['First player'], [entry(['First player']), entry(['Next player'], { params: { ...contract.params, offset: 20 } })])
  expect(playerViewReady(page)).toBe(false)
  fixture(['Next player'], [entry(['Next player'], { params: { ...contract.params, offset: 20 } })])
  expect(playerViewReady(page)).toBe(true)
  fixture([], [entry([], { params: { ...contract.params, offset: 20 } })], 'No players match these filters')
  expect(playerViewReady(page)).toBe(false)
})

it('keeps filter selection assertions and adds visible result checks to every filter', async () => {
  const work = await inventory()
  const filters = work.scenarios.filter((scenario: { name: string }) => scenario.name.startsWith('perf-filter-'))
  expect(filters).toHaveLength(70)
  for (const scenario of filters) {
    expect(scenario.prepare.slice(1, 3)).toEqual([{ tapPrefix: 'Sort:', dialog: 'Filters' }, { tap: 'Fantasy Pts', dialog: 'Sort' }])
    expect(scenario.steps[0].expected.playerView).toBeUndefined()
    expect(scenario.steps.at(-1).expected.playerView).toBeDefined()
    expect(scenario.steps.at(-1).action).toEqual({ tapPrefix: 'Show ', dialog: 'Filters' })
  }
})

it('checks both sort directions after dismissing the filter sheet', () => {
  const scenario = currentScenario({ name: 'perf-filter-sort-direction', prepare: [{ tap: 'Show filters' }], steps: [
    { name: 'ascending', action: { tap: 'Highest first ↓', dialog: 'Filters' }, expected: { text: 'Lowest first ↑' } },
    { name: 'descending', action: { tap: 'Lowest first ↑', dialog: 'Filters' }, expected: { text: 'Highest first ↓' } },
  ] })
  expect(scenario.steps.map((step: { name: string }) => step.name)).toEqual(['ascending', 'ascending-results', 'descending', 'descending-results'])
  expect(scenario.steps[1].expected.playerView.params.sortDir).toBe('asc')
  expect(scenario.steps[3].expected.playerView.params.sortDir).toBe('desc')
})
