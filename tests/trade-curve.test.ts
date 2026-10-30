import { describe, expect, it } from 'vitest'
import { analyzeDynastyTrade, type DynastyEngineContext, type DynastyPlayerAsset } from '../core/src/dynasty/decisionEngine'
import { compareTradeTotals, curveTradeValue, scoreTradeSides, tradeRosterSpotValue } from '../core/src/dynasty/tradeScoring'

const player = (id: string, tradeValue: number): DynastyPlayerAsset => ({
  id, kind: 'player', label: id, tradeValue, age: null, dynastyRank: null, rankMovement: null, healthStatus: null,
})
const context: DynastyEngineContext = { leagueId: 'league', seasonYear: 2027, scoringSettings: {} }
const rosterPlayer = (playerId: string, tradeValue: number, location: 'active' | 'ir' | 'taxi' = 'active') => ({ playerId, tradeValue, location })
const limits = { active: 2, ir: 1, taxi: 1 }
const routes = [
  { fromMemberId: 'a', toMemberId: 'b', asset: player('star', 950) },
  { fromMemberId: 'b', toMemberId: 'a', asset: player('one', 500) },
  { fromMemberId: 'b', toMemberId: 'a', asset: player('two', 500) },
]

describe('curved trade totals', () => {
  it.each([
    [950, 773.780937], [942, 741.744806], [900, 590.49], [851, 446.321492], [800, 327.68], [700, 168.07], [698, 165.682681],
    [600, 77.76], [500, 31.25], [300, 2.43], [107, 0.014026], [0, 0], [1000, 1000],
  ])('curves source %s to %s', (source, expected) => {
    expect(curveTradeValue(source)).toBeCloseTo(expected, 6)
  })
  it('compares Luka with Duren, Sarr, Castle, and George before roster terms', () => {
    const score = scoreTradeSides([942], [698, 695, 692, 648])
    expect(score.valuesSent).toBeCloseTo(741.744806, 6)
    expect(score.valuesReceived).toBeCloseTo(600.773297, 6)
    expect(score).toMatchObject({ fair: false, packageEffect: 0 })
    expect(score.gapPercent).toBeCloseTo(19.005392, 5)
  })
  it('credits the team receiving Luka 75 and charges the four-player recipient 75 before cuts', () => {
    const packageValues = [698, 695, 692, 648]
    const trade = [
      { fromMemberId: 'package', toMemberId: 'luka', asset: player('luka', 942) },
      ...packageValues.map((value, index) => ({ fromMemberId: 'luka', toMemberId: 'package', asset: player(`piece-${index}`, value) })),
    ]
    const result = analyzeDynastyTrade({ ...context, rosters: [
      { memberId: 'luka', limits: { ...limits, active: 4 }, players: packageValues.map((value, index) => rosterPlayer(`piece-${index}`, value)) },
      { memberId: 'package', limits: { ...limits, active: 4 }, players: [rosterPlayer('luka', 942)] },
    ] }, 'overall', trade)
    const [luka, pack] = result.teams
    expect(tradeRosterSpotValue(4, 1)).toBe(75)
    expect(tradeRosterSpotValue(1, 4)).toBe(-75)
    expect(luka).toMatchObject({ memberId: 'luka', rosterSlotEffect: 75, rosterCutValue: 0 })
    expect(pack).toMatchObject({ memberId: 'package', rosterSlotEffect: -75, rosterCutValue: 0 })
    expect(luka.adjustedValue).toBeCloseTo(816.744806, 6)
    expect(pack.adjustedValue).toBeCloseTo(525.773297, 6)
    expect(luka.netValue).toBeCloseTo(215.971509, 6)
    expect(pack.netValue).toBeCloseTo(-215.971509, 6)
  })
  it('values Gilgeous-Alexander far above two 500s', () => {
    const score = scoreTradeSides([950], [500, 500])
    expect(score.valuesSent).toBeCloseTo(773.780937, 6)
    expect(score.valuesReceived).toBeCloseTo(62.5, 6)
    expect(score.netValue).toBeCloseTo(-711.280937, 6)
    expect(score.fair).toBe(false)
  })
  it('uses the larger total for an inclusive 5% gap and handles zeros and negatives', () => {
    expect(compareTradeTotals([1000, 950])).toEqual({ fair: true, gapPercent: 5 })
    expect(compareTradeTotals([1000, 949.999]).fair).toBe(false)
    expect(compareTradeTotals([0, 0])).toEqual({ fair: true, gapPercent: 0 })
    expect(compareTradeTotals([-5, 5])).toEqual({ fair: false, gapPercent: 200 })
    for (const value of [-1, NaN, Infinity, 1000.1]) expect(curveTradeValue(value)).toBe(0)
  })
  it('adds required weakest-player cuts to the flat charge for extra players', () => {
    const analysis = analyzeDynastyTrade({ ...context, bestFreeAgentValue: 107, rosters: [
      { memberId: 'a', limits, players: [rosterPlayer('star', 950), rosterPlayer('weak', 100)] },
      { memberId: 'b', limits, players: [rosterPlayer('one', 500), rosterPlayer('two', 500)] },
    ] }, 'overall', routes)
    const [a, b] = analysis.teams
    expect(a.rosterCutValue).toBeCloseTo(curveTradeValue(100), 6)
    expect(a.rosterSlotEffect).toBeCloseTo(-25 - curveTradeValue(100), 6)
    expect(a.openRosterSpots).toBe(0)
    expect(b.openRosterSpots).toBe(1)
    expect(b.rosterSlotEffect).toBe(25)
    expect(b.netValue).toBeCloseTo(711.280937 + 25, 5)
    expect(b.gapPercent).toBeLessThan(100)
    expect(a.fair).toBe(false)
  })
  it('does not credit pre-existing vacancies or depend on the free-agent value', () => {
    const result = analyzeDynastyTrade({ ...context, bestFreeAgentValue: 300, rosters: [
      { memberId: 'a', limits: { ...limits, active: 4 }, players: [rosterPlayer('star', 950)] },
      { memberId: 'b', limits: { ...limits, active: 4 }, players: [rosterPlayer('one', 500), rosterPlayer('two', 500)] },
    ] }, 'overall', routes)
    expect(result.teams.map(team => team.openRosterSpots)).toEqual([2, 3])
    expect(result.teams.map(team => team.rosterCutValue)).toEqual([0, 0])
    expect(result.teams.map(team => team.rosterSlotEffect)).toEqual([-25, 25])
  })
  it('keeps taxi and IR destinations while valuing equal player counts at zero', () => {
    const result = analyzeDynastyTrade({ ...context, bestFreeAgentValue: 500, rosters: [
      { memberId: 'a', limits: { active: 1, ir: 1, taxi: 1 }, players: [rosterPlayer('taxi', 698, 'taxi'), rosterPlayer('active', 950)] },
      { memberId: 'b', limits: { active: 1, ir: 1, taxi: 1 }, players: [rosterPlayer('ir', 500, 'ir')] },
    ] }, 'overall', [
      { fromMemberId: 'a', toMemberId: 'b', asset: player('taxi', 698) },
      { fromMemberId: 'b', toMemberId: 'a', destination: 'ir', asset: player('ir', 500) },
    ])
    expect(result.teams[0].rosterSlotEffect).toBe(0)
    expect(result.teams[1].openRosterSpots).toBe(1)
    expect(result.teams[1].rosterSlotEffect).toBe(0)
  })
  it('counts taxi players and zero-value players as roster spots, but excludes picks and FAAB', () => {
    const result = analyzeDynastyTrade({ ...context, rosters: [
      { memberId: 'a', limits, players: [rosterPlayer('taxi', 0, 'taxi')] },
      { memberId: 'b', limits, players: [] },
    ] }, 'overall', [
      { fromMemberId: 'a', toMemberId: 'b', asset: player('taxi', 0) },
      { fromMemberId: 'b', toMemberId: 'a', asset: { kind: 'pick', id: 'pick', label: 'Pick', seasonYear: 2028, round: 1, slot: null, teams: 12, valueBands: { early: 900, mid: 500, late: 300 } } },
      { fromMemberId: 'b', toMemberId: 'a', asset: { kind: 'faab', id: 'cash', label: 'FAAB', amount: 20, budget: 100, freeAgentQuality: 0.5 } },
    ])
    expect(result.teams.map(team => team.rosterSlotEffect)).toEqual([25, -25])
    expect(result.teams.map(team => team.rosterCutValue)).toEqual([0, 0])
  })
  it('curves picks once and preserves their source bands', () => {
    const analysis = analyzeDynastyTrade(context, 'overall', [{ fromMemberId: 'a', toMemberId: 'b', asset: {
      kind: 'pick', id: 'pick', label: 'Pick', seasonYear: 2028, round: 1, slot: null, teams: 12,
      valueBands: { early: 900, mid: 500, late: 300 },
    } }])
    expect(analysis.assets[0].values.overall).toBe(500)
    expect(analysis.teams[0].valuesSent).toBeCloseTo(curveTradeValue(500), 6)
  })
  it('keeps FAAB on its existing scale and routes multi-team rosters independently', () => {
    const analysis = analyzeDynastyTrade({ ...context, bestFreeAgentValue: 0, rosters: ['a', 'b', 'c'].map(memberId => ({
      memberId, limits: { ...limits, active: 1 }, players: [rosterPlayer(memberId, 500)],
    })) }, 'overall', [
      { fromMemberId: 'a', toMemberId: 'b', asset: player('a', 500) },
      { fromMemberId: 'b', toMemberId: 'c', asset: player('b', 500) },
      { fromMemberId: 'c', toMemberId: 'a', asset: player('c', 500) },
      { fromMemberId: 'a', toMemberId: 'b', asset: { kind: 'faab', id: 'cash', label: 'FAAB', amount: 20, budget: 100, freeAgentQuality: 0.5 } },
    ])
    expect(analysis.teams.map(team => team.rosterSlotEffect)).toEqual([0, 0, 0])
    expect(analysis.teams[0].valuesSent).toBeCloseTo(curveTradeValue(500) + 20, 6)
  })
})
