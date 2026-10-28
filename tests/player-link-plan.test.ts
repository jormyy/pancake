import { describe, expect, it } from 'vitest'
import { planNbaLinks, type NbaLinkPlayer } from '../supabase/functions/sync-players/nbaLinkPlan'

const player: NbaLinkPlayer = { id: 'player', display_name: 'Nikola Jokić', nba_id: '1', nba_team: 'DEN',
  espn_id: 'espn', sleeper_id: 'sleeper', years_exp: 8, position: 'C', eligible_positions: ['C'] }
const record = { provider_id: '1', display_name: 'Nikola Jokic', nba_team: 'DEN', years_exp: 8, position: 'C' }

describe('NBA link progress', () => {
  it('skips a completed link without changing its receipt', () => {
    expect(planNbaLinks([record], [player], true)).toEqual({ pending: [], completed: [{ index: 0, player_id: 'player', action: 'unchanged' }] })
  })

  it.each([
    { nba_team: 'BOS' }, { years_exp: null }, { position: null }, { eligible_positions: [] },
  ])('retries missing metadata or a moved roster: %j', changes => {
    expect(planNbaLinks([record], [{ ...player, ...changes }], true).pending).toEqual([{ index: 0, record }])
  })

  it('leaves name collisions and identity conflicts to the atomic linker', () => {
    const duplicate = { ...player, id: 'duplicate', nba_id: null, display_name: 'Nikola Jokić' }
    expect(planNbaLinks([record], [player, duplicate], true).pending).toHaveLength(1)
    expect(planNbaLinks([{ ...record, espn_id: 'conflicting' }], [player], true).pending).toHaveLength(1)
  })

  it('rejects duplicate source identities even when both appear complete', () => {
    expect(() => planNbaLinks([record, record], [player], true)).toThrow('Source identities must be unique')
  })

  it('does not treat suffixes or letters as identical', () => {
    const other = { ...player, id: 'other', nba_id: null, display_name: 'Nikola Jokic Jr.' }
    expect(planNbaLinks([record], [player, other], true).pending).toHaveLength(0)
  })

  it('keeps unlinked candidates after interrupted batches while skipping committed records', () => {
    const records = Array.from({ length: 125 }, (_, index) => ({ ...record, provider_id: String(index) }))
    const players = records.map((row, index) => ({ ...player, id: String(index), nba_id: index < 50 ? row.provider_id : null,
      display_name: `Other ${index}`, nba_team: 'BOS' }))
    expect(planNbaLinks(records, players, false).pending.map(row => row.index)).toEqual(Array.from({ length: 75 }, (_, index) => index + 50))
  })

  it('respects incomplete roster evidence and every original input position', () => {
    const result = planNbaLinks([{ ...record, provider_id: 'missing' }, record], [{ ...player, nba_team: 'BOS' }], false)
    expect(result.pending.map(row => row.index)).toEqual([0])
    expect(result.completed).toEqual([{ index: 1, player_id: 'player', action: 'unchanged' }])
  })
})
