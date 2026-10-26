import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeRosterPreviewList } from '@/components/trades/TradeRosterPreviewList'
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

it.each([0, 1, 2])('reports %s required drops from the displayed roster counts', async excess => {
    const team: TradeRosterPreview = { memberId: 'partner', teamName: 'Team 006', limits: { active: 20, ir: 2, taxi: 3 },
        roster: Array.from({ length: 20 + excess }, (_, i) => ({ playerId: String(i), name: `Player ${i}`, location: 'active' })), drops: [], moves: [], error: null }
    await act(async () => { screen = create(React.createElement(TradeRosterPreviewList, { teams: [team] })) })
    expect(texts()).toContain(`Regular: ${20 + excess}/20`)
    if (excess) expect(texts()).toContain(`Team 006 must drop ${excess} ${excess === 1 ? 'player' : 'players'} to accept.`)
    else expect(texts().join(' ')).not.toContain('must drop')
})

it('counts overflow across each shown roster group', async () => {
    const team: TradeRosterPreview = { memberId: 'partner', teamName: 'Team 006', limits: { active: 0, ir: 0, taxi: 0 }, roster: [
        { playerId: 'a', name: 'A', location: 'active' }, { playerId: 'b', name: 'B', location: 'ir' }, { playerId: 'c', name: 'C', location: 'taxi' },
    ], drops: [], moves: [], error: null }
    await act(async () => { screen = create(React.createElement(TradeRosterPreviewList, { teams: [team] })) })
    expect(texts()).toContain('Team 006 must drop 3 players to accept.')
})

it('renders the complete asset values and range without a line limit', async () => {
    const analysis = { strategy: 'balanced', confidence: 1, teams: [], assets: [{ kind: 'player', assetId: 'player', label: 'Player', values: { balanced: 348 }, components: { shortTermPoints: 9.3, longTermValue: 419 }, ranges: { balanced: { low: 306, high: 390 } }, confidence: 1 }], sources: [], missingInputs: [], assumptions: [] } as unknown as DynastyTradeAnalysis
    await act(async () => { screen = create(React.createElement(TradeAnalysisSummary, { analysis, participantName: String })) })
    expect(texts()).toContain('Value 348 · Current 9.3 · Long-term 419')
    expect(texts()).toContain('Range 306–390')
    for (const node of screen.root.findAllByType('Text' as React.ElementType).filter(node => /Value 348|Range 306/.test(React.Children.toArray(node.props.children).join('')))) expect(node.props.numberOfLines).toBeUndefined()
})
