import { expect, it } from 'vitest'
import { emptyPlan, withEmptyState } from '../../scripts/perf-lab/empty.mjs'

it('executes a scoped empty-state fixture and restores rows when the assertion fails', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const calls: string[] = []
  const execute = async (query: string) => {
    calls.push(query)
    return query.startsWith('SELECT coalesce') ? JSON.stringify([{ id, title: "Manager's move" }]) : '0'
  }
  await expect(withEmptyState({ id: 'league-dashboard.history' }, { leagueId: id, members: [{ id }] }, { memberId: id, otherMemberId: id }, async (fixture: { expected: { text: string }; evidence: { tables: { table: string; removed: number }[] } }) => {
    expect(fixture.expected.text).toBe('No transactions yet.')
    expect(fixture.evidence.tables).toEqual([{ table: 'league_activity', removed: 1 }, { table: 'roster_transactions', removed: 1 }])
    throw new Error('screen failed')
  }, execute)).rejects.toThrow('screen failed')
  expect(calls.filter(query => query.startsWith('DELETE'))).toHaveLength(2)
  expect(calls.slice(-2).every(query => query.startsWith('INSERT') && query.includes("Manager''s move"))).toBe(true)
  expect(emptyPlan({ id: 'notification-settings' })).toBe(null)
})

it('uses an actual unmatched query for empty search instead of a fabricated empty response', () => {
  const plan = emptyPlan({ id: 'players.players' })
  if (!plan?.actions || !('text' in plan.expected)) throw new Error('Missing search fixture')
  expect(plan.actions[0].fill).toBe('Search players')
  expect(plan.expected.text).toContain(plan.actions[0].value)
  expect(plan.tables).toEqual([])
})

it.each(['auth-sign-in', 'auth-sign-up', 'create-league', 'join-league', 'change-password'])('clears every text field in the %s empty form without changing server data', async id => {
  const plan = emptyPlan({ id })
  expect(plan?.kind).toBe('empty-form')
  expect(plan?.tables).toEqual([])
  expect(plan?.actions?.length).toBeGreaterThan(1)
  expect(plan?.actions?.every((action: { value: string }) => action.value === '')).toBe(true)
  if (!plan || !('all' in plan.expected)) throw new Error('Missing form contract')
  expect(plan.expected.all.every((field: { value: { selector: string; equals: string } }) => field.value.selector.startsWith('[aria-label=') && field.value.equals === '')).toBe(true)
})

it('does not issue database writes for an empty form fixture', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const execute = async () => { throw new Error('Unexpected database request') }
  let reached = false
  await withEmptyState({ id: 'auth-sign-up' }, { leagueId: id, members: [{ id }] }, { memberId: id, otherMemberId: id }, async (fixture: { kind: string }) => {
    expect(fixture.kind).toBe('empty-form')
    reached = true
  }, execute)
  expect(reached).toBe(true)
})

it('uses the real prospect search for an empty rookie list', () => {
  const plan = emptyPlan({ id: 'rookie-draft-room' })
  expect(plan?.actions).toEqual([{ tap: 'Show prospects' }, { fill: 'Search prospects', value: 'PancakeEmptyFixtureNoMatch' }])
  expect(plan?.expected).toEqual({ text: 'No matching prospects' })
  expect(plan?.tables).toEqual([])
})

it('clears the claim bid without submitting or mutating server data', () => {
  const plan = emptyPlan({ id: 'claim-player' })
  expect(plan?.actions).toEqual([{ fill: 'FAAB bid amount', value: '' }])
  expect(plan?.tables).toEqual([])
})

it('uses a real timeline deep link that has no matching entity', () => {
  const plan = emptyPlan({ id: 'team-timeline' })
  expect(plan?.actions).toEqual([{ open: '/timeline?entityId=PancakeEmptyFixtureNoMatch' }])
  expect(plan?.tables).toEqual([])
  expect(plan?.expected).toMatchObject({ any: [
    { text: 'No matching activity on this page. Load older activity to continue.' },
    { text: 'No activity here yet. Team results appear here when they happen.' },
  ] })
})

it.each(['playoff-bracket', 'league-dashboard.bracket'])('requires actual empty bracket content for %s', id => {
  expect(emptyPlan({ id })).toEqual({ expected: { text: 'No playoff bracket yet' }, tables: [] })
})

it('opens the profile editor and clears its visible fields without saving', () => {
  const plan = emptyPlan({ id: 'profile' })
  expect(plan?.actions).toEqual([{ tap: 'Edit' }, { fill: 'Display name', value: '' }, { fill: 'Team name', value: '' }])
  expect(plan?.tables).toEqual([])
  expect(plan?.expected).toEqual({ all: [
    { value: { selector: '[aria-label="Display name"]', equals: '' } },
    { value: { selector: '[aria-label="Team name"]', equals: '' } },
  ] })
})

it('requires an empty trade composer to keep Review disabled', () => {
  expect(emptyPlan({ id: 'propose-trade' })).toEqual({ expected: { all: [
    { text: 'Choose a team.' },
    { selector: '[aria-label="Review trade proposal"][aria-disabled="true"]' },
  ] }, tables: [] })
})

it('requires both trade-block lists and completed history to be empty', () => {
  expect(emptyPlan({ id: 'trades.block' })?.expected).toEqual({ all: [{ text: 'No league listings yet.' }, { text: 'No listings yet.' }] })
  expect(emptyPlan({ id: 'trades.history' })?.expected).toEqual({ text: 'No completed trades yet.' })
})

it('removes and restores only the global news table for an empty news feed', async () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const calls: string[] = []
  await withEmptyState({ id: 'players.news' }, { leagueId: id, members: [{ id }] }, { memberId: id, otherMemberId: id }, async (plan: { expected: { text: string } }) => {
    expect(plan.expected).toEqual({ text: 'No dynasty news yet.' })
  }, async (query: string) => {
    calls.push(query)
    return query.startsWith('SELECT coalesce') ? JSON.stringify([{ id, title: "Player's news" }]) : '0'
  })
  expect(calls).toContain('DELETE FROM public.dynasty_news WHERE true')
  expect(calls.at(-1)).toContain("Player''s news")
  expect(calls.every(query => !query.includes('league_id'))).toBe(true)
})
