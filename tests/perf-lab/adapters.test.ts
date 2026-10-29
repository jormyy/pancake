import { expect, it } from 'vitest'
import { changeForScreen } from '../../scripts/perf-lab/server-change.mjs'
import { currentScenario } from '../../scripts/perf-lab/scenario-adapters.mjs'

const id = '00000000-0000-4000-8000-000000000001'

it('changes visible league content on roster and trade screens, then restores it', async () => {
  for (const screen of ['roster', 'trades']) {
    const calls: string[] = []
    const execute = async (query: string) => { calls.push(query); return 'Fixture league' }
    const seen: unknown[] = []
    const result = await changeForScreen({ id: screen }, { leagueId: id }, { memberId: id }, { execute, verify: async (expected: unknown) => { seen.push(expected) } })
    expect(seen).toEqual([{ text: 'Fixture league' }])
    expect(result.expected).toEqual({ text: 'Fixture league refreshed' })
    expect(calls.every(query => query.includes('leagues'))).toBe(true)
    await result.undo()
    expect(calls.at(-1)).toContain("name='Fixture league'")
  }
})

it('requires the roster player to appear before changing and restoring its visible name', async () => {
  const row = { id, player_id: id, member_id: id }
  const calls: string[] = []
  const execute = async (query: string) => {
    calls.push(query)
    return query.startsWith('SELECT row_to_json') ? JSON.stringify(row) : 'Fixture player'
  }
  const seen: unknown[] = []
  const result = await changeForScreen({ id: 'team-roster' }, { leagueId: id }, { otherMemberId: id }, { execute, verify: async (expected: unknown) => { seen.push(expected) } })
  expect(seen).toEqual([{ text: 'Fixture player' }])
  expect(result.expected).toEqual({ text: 'Fixture player refreshed' })
  expect(calls.at(-1)).toBe(`UPDATE players SET display_name='Fixture player refreshed' WHERE id='${id}'`)
  await result.undo()
  expect(calls.at(-1)).toBe(`UPDATE players SET display_name='Fixture player' WHERE id='${id}'`)
})

it('asserts both incoming and outgoing trade detail actions without requiring acceptance for the proposer', () => {
  const result = currentScenario({ name: 'trades-details-light', steps: [{ action: { tapPrefix: 'Show details' }, expected: {} }] })
  expect(result.steps[0].expected.all[1].any).toEqual([{ selector: '[aria-label^="Accept trade with "]' }, { selector: '[aria-label^="Edit trade with "]' }])
})

it('signs back in as the selected manager instead of the fixed commissioner fixture', () => {
  const result = currentScenario({ name: 'shell-auth-return-sign-in', prepare: [{ fill: 'Email', value: 'fixed' }, { fill: 'Password', value: 'fixed' }], steps: [] })
  expect(result.prepare).toEqual([{ fill: 'Email', value: '{{userEmail}}' }, { fill: 'Password', value: '{{userPassword}}' }])
})

it('uses the current Revalue label for trade analysis in preparation and measured actions', () => {
  const result = currentScenario({ name: 'trades-analyzer-offline-light', prepare: [{ tapPrefix: 'Analyze trade from ' }], steps: [{ action: { tapPrefix: 'Analyze trade from ' }, expected: { text: 'cached' } }] })
  expect(result.prepare[0]).toEqual({ tapPrefix: 'Revalue trade from ' })
  expect(result.steps[0].action).toEqual({ tapPrefix: 'Revalue trade from ' })
})

it('returns from the tabbed analyzer through Offers during offline preparation', () => {
  const result = currentScenario({ name: 'trades-analyzer-offline-light', prepare: [{ tap: 'Back to trades' }], steps: [] })
  expect(result.prepare).toEqual([{ tapPrefix: 'Offers' }])
})

it('keeps roster membership intact while changing visible team-roster content', async () => {
  const writes: string[] = []
  const execute = async (query: string) => {
    if (query.startsWith('SELECT row_to_json')) return JSON.stringify({ id, player_id: id, member_id: id })
    if (query.startsWith('SELECT display_name')) return 'Fixture player'
    if (query.startsWith('DELETE')) throw new Error('Deleting a roster player expires pending trades')
    writes.push(query)
    return ''
  }
  const result = await changeForScreen({ id: 'team-roster' }, { leagueId: id }, { otherMemberId: id }, { execute })
  expect(result.expected).toEqual({ text: 'Fixture player refreshed' })
  await result.undo()
  expect(writes).toHaveLength(2)
  expect(writes.every(query => query.startsWith('UPDATE players SET display_name='))).toBe(true)
})

it('does not rename a restored production player through a mistaken roster scope', async () => {
  const writes: string[] = []
  const execute = async (query: string) => {
    if (query.startsWith('SELECT row_to_json')) return JSON.stringify({ id, player_id: id })
    if (query.startsWith('SELECT display_name')) return ''
    writes.push(query)
    return ''
  }
  await expect(changeForScreen({ id: 'team-roster' }, { leagueId: id }, { otherMemberId: id }, { execute })).rejects.toThrow('only synthetic players')
  expect(writes).toEqual([])
})

it('checks saved Analyzer values instead of the removed cached badge', () => {
  const source = { name: 'trades-analyzer-offline-light', prepare: [], steps: [{ name: 'result', action: { tap: 'View trade analysis' }, expected: { text: 'cached' } }] }
  const result = currentScenario(source)
  expect(result.steps[0].expected).toEqual({ all: [{ selector: '[aria-label="Dynasty trade analysis"]' }, { text: 'Value ' }] })
  expect(source.steps[0].expected).toEqual({ text: 'cached' })
})
