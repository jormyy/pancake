import { describe, expect, it } from 'vitest'
import { TRADE_FORMULA_VERSION, valueDynastyAsset } from '../core/src/dynasty/tradeScoring'
const estimateModule = '../supabase/functions/_shared/tradeEstimate'
const { analyzeTradeEstimate } = await import(estimateModule)

describe('imported trade scoring', () => {
  it('keeps the complete estimate shape and source values', () => {
    const input = {
      leagueId: 'league', seasonId: 'season', seasonYear: 2027, teams: 12, rosterSize: 20, scoringSettings: {}, faabBudget: 100,
      terms: [{ fromMemberId: 'a', toMemberId: 'b', playerId: 'p', pickId: null, faabAmount: 0 }],
      players: [{ player_id: 'p', display_name: 'Player', trade_value: 999.9 as number | null, age: 40, five_year_rank: 500, three_year_rank: 500,
        ranking_fetched_at: null, projection_fetched_at: null, projection_source: null, rank_change: -100,
        injury_status: 'OUT', avg_fantasy_points: null, projection_fantasy_points: null, years_exp: 20, ranking_source: null }],
      replacementPlayers: [], picks: [],
    }
    const result = analyzeTradeEstimate(input, 0)
    expect(TRADE_FORMULA_VERSION).toBe('onenumber-trade-curve-v6')
    expect(result.assets[0].values).toEqual({ overall: 999.9, contend: 999.9, rebuild: 999.9 })
    const shape = (value: unknown): unknown => Array.isArray(value) ? value.slice(0, 1).map(shape)
      : value != null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value
    expect(shape(result)).toMatchSnapshot()
    input.players[0].trade_value = null
    expect(analyzeTradeEstimate(input, 0).assets[0].values.overall).toBe(0)
  })
})

it('uses derived pick bands and the existing FAAB rate without fallback scoring', () => {
  const context = { leagueId: 'league', seasonYear: 2027, scoringSettings: {} }
  const pick = { kind: 'pick' as const, id: 'pick', label: 'Third', seasonYear: 2028, round: 3, slot: null, teams: 12,
    valueBands: { early: 200, mid: 180, late: 160 } }
  expect(valueDynastyAsset(context, pick)).toMatchObject({ values: { overall: 180 }, ranges: { overall: { low: 160, high: 200 } } })
  expect(valueDynastyAsset(context, { ...pick, slot: 1 }).values.overall).toBe(200)
  const faab = { kind: 'faab' as const, id: 'funds', label: 'FAAB', amount: 200, budget: 100, freeAgentQuality: 0.5 }
  expect(valueDynastyAsset(context, faab).values).toEqual({ overall: 195, contend: 195, rebuild: 195 })
  expect(valueDynastyAsset(context, { ...faab, budget: 0 }).values.overall).toBe(0)
})


it('uses net player counts and real roster limits without a free-agent credit', () => {
  const row = { player_id: 'player', display_name: 'Player', trade_value: 500, age: null, five_year_rank: null, three_year_rank: null,
    ranking_fetched_at: null, projection_fetched_at: null, projection_source: null, rank_change: null,
    injury_status: null, avg_fantasy_points: null, projection_fantasy_points: null, years_exp: null, ranking_source: null }
  const input = {
    leagueId: 'league', seasonId: 'season', seasonYear: 2027, teams: 12, rosterSize: 1, scoringSettings: {}, faabBudget: 100,
    terms: [{ fromMemberId: 'a', toMemberId: 'b', playerId: 'player', pickId: null, faabAmount: 0 }],
    players: [row], replacementPlayers: [{ ...row, player_id: 'sample', trade_value: 999.9 }], picks: [], bestFreeAgentValue: 107,
    playerDestinations: { player: 'ir' },
    rosters: [
      { memberId: 'a', limits: { active: 1, ir: 1, taxi: 0 }, players: [{ playerId: 'player', tradeValue: 500, location: 'active' }] },
      { memberId: 'b', limits: { active: 1, ir: 1, taxi: 0 }, players: [] },
    ],
  }
  const analysis = analyzeTradeEstimate(input, 0)
  expect(analysis.teams.map((team: { rosterSlotEffect: number }) => team.rosterSlotEffect)).toEqual([0, 0])
  expect(analysis.teams[0].valuesSent).toBe(31.25)
  expect(analysis.assets[0].values.overall).toBe(500)
  expect(analyzeTradeEstimate({ ...input, bestFreeAgentValue: undefined }, 0)).toEqual(analysis)
})
