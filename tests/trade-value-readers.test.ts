import { describe, expect, it, vi } from 'vitest'
import { valueDynastyAsset, type DynastyPlayerAsset } from '../core/src/dynasty/decisionEngine'
import { displayedTradeValues, formatTradeValue } from '../lib/trade-estimates'
import { dynastyPickBands, playerAssetFromDecisionInput, type DynastyDecisionInput, type DynastyPickValue } from '../lib/dynasty-decisions'
import type { Trade } from '../lib/trades'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
const context = { leagueId: 'league', seasonYear: 2027, scoringSettings: {} }
const player: DynastyPlayerAsset = { kind: 'player', id: 'player', label: 'Player', age: 25, dynastyRank: 50, rankMovement: 0, healthStatus: null }

describe('stored dynasty value readers', () => {
  it('keeps decimal values readable without floating point tails', () => {
    expect(formatTradeValue(0.1 + 0.2)).toBe('0.3')
    expect(formatTradeValue(121.12)).toBe('121.12')
  })
  it('uses the exact stored player value across strategies, independent of old inputs', () => {
    const result = valueDynastyAsset(context, { ...player, tradeValue: 999.9, age: 40, healthStatus: 'OUT' })
    expect(result.values).toEqual({ overall: 999.9, contend: 999.9, rebuild: 999.9 })
    expect(valueDynastyAsset(context, { ...player, tradeValue: 0 }).values.overall).toBe(0)
    expect(valueDynastyAsset(context, player).values.overall).not.toBe(999.9)
    expect(valueDynastyAsset(context, { ...player, tradeValue: null }).values).toEqual(valueDynastyAsset(context, player).values)
  })
  it('passes the preferred row value into the player engine', () => {
    const row = { player_id: 'player', display_name: 'Player', trade_value: 456.7, five_year_rank: 3 } as DynastyDecisionInput
    expect(playerAssetFromDecisionInput(row).tradeValue).toBe(456.7)
  })
  it('reads complete pick bands and retains the old curve when bands are absent', () => {
    const rows = ['early', 'mid', 'late'].map((tier, index) => ({ draft_year: 2027, round: 1, tier, trade_value: [750.1, 496.7, 391.4][index] })) as DynastyPickValue[]
    const bands = dynastyPickBands(rows, 2027, 1)
    const pick = { kind: 'pick' as const, id: 'pick', label: 'Pick', seasonYear: 2028, round: 1, slot: null, teams: 12 }
    expect(valueDynastyAsset(context, { ...pick, valueBands: bands }).values.overall).toBe(496.7)
    expect(valueDynastyAsset(context, { ...pick, slot: 1, valueBands: bands }).values.overall).toBe(750.1)
    expect(valueDynastyAsset(context, { ...pick, slot: 12, valueBands: bands }).values.overall).toBe(391.4)
    expect(dynastyPickBands(rows, 2030, 1)).toBeNull()
    expect(valueDynastyAsset(context, { ...pick, valueBands: null }).values).toEqual(valueDynastyAsset(context, pick).values)
  })
  it('prefers current trade-card values and falls back to saved asset values', () => {
    const trade = { proposerMemberId: 'a', routedItems: [
      { kind: 'player', playerId: 'p1', fromMemberId: 'a', toMemberId: 'b', tradeValue: 999.9 },
      { kind: 'player', playerId: 'p2', fromMemberId: 'b', toMemberId: 'a', tradeValue: null },
    ], estimate: { teams: [{ memberId: 'a', valuesSent: 100, valuesReceived: 200 }],
      assets: [{ assetId: 'p1', values: { overall: 100 } }, { assetId: 'p2', values: { overall: 200 } }] } } as unknown as Trade
    expect(displayedTradeValues(trade, 'a')).toEqual({ valuesSent: 999.9, valuesReceived: 200 })
    trade.routedItems[0].tradeValue = null
    expect(displayedTradeValues(trade, 'a')).toEqual({ valuesSent: 100, valuesReceived: 200 })
    trade.routedItems[0].tradeValue = 999.9
    trade.routedItems[1].tradeValue = 950.4
    trade.estimate = null
    trade.participants = [{ memberId: 'a' }] as Trade['participants']
    expect(displayedTradeValues(trade, 'a')).toEqual({ valuesSent: 999.9, valuesReceived: 950.4 })
  })
})
