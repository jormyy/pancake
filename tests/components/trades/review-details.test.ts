import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { tradeRosterReasons } from '@/lib/trade-roster-status'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import type { TradeRosterPreview } from '@/lib/trades'
import type { DynastyTradeAnalysis } from '@pancake/core'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: ({ stats }: { stats: React.ReactNode }) => stats }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: React.PropsWithChildren) => children }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const texts = () => screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join(''))
afterEach(async () => act(async () => screen?.unmount()))

it.each([0, 1, 2])('keeps capacity reasons compact with %s excess players', excess => {
    const team: TradeRosterPreview = { memberId: 'partner', teamName: 'Team 006', limits: { active: 20, ir: 2, taxi: 3 },
        roster: Array.from({ length: 20 + excess }, (_, i) => ({ playerId: String(i), name: `Player ${i}`, location: 'active' })),
        drops: [], moves: [], error: null, reasons: excess ? [{ memberId: 'partner', teamName: 'Team 006', rule: 'active_slots', message: 'Long explanation.', suggestedMoves: [] }] : [] }
    expect(tradeRosterReasons(team)).toEqual(excess ? [`${excess} over roster limit (${20 + excess}/20)`] : [])
})

it('keeps complete asset values and range on one line', async () => {
    const analysis = { strategy: 'balanced', confidence: 1, teams: [], assets: [{ kind: 'player', assetId: 'player', label: 'Player', values: { balanced: 348 }, components: { shortTermPoints: 9.3, longTermValue: 419 }, ranges: { balanced: { low: 306, high: 390 } }, confidence: 1 }], sources: [], missingInputs: [], assumptions: [] } as unknown as DynastyTradeAnalysis
    await act(async () => { screen = create(React.createElement(TradeAnalysisSummary, { analysis, participantName: String })) })
    expect(texts()).toContain('Trade value 5.1 · Source 348 · 2.68–9.02')
    for (const caption of ['Estimated trade value', 'Input quality', 'Asset details', 'Sources and limits']) expect(texts().join(' ')).not.toContain(caption)
    expect(texts().join(' ')).not.toContain('Missing:')
    for (const node of screen.root.findAllByType('Text' as React.ElementType).filter(node => /Trade value 5.1/.test(React.Children.toArray(node.props.children).join('')))) expect(node.props.numberOfLines).toBe(1)
})
