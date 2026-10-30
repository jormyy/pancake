import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { SavedTradeEstimate } from '@/components/trades/SavedTradeEstimate'
import { trade } from '../../helpers/fixtures'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/Motion', () => ({ MotionPressable: 'Pressable' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ current: null, currentLeague: null }) }))
vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: vi.fn() }))
vi.mock('@/components/trades/TradeAnalysisSummary', () => ({ TradeAnalysisSummary: 'Summary' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('keeps estimate numbers without saved date or source captions', async () => {
    const value = trade({ estimate: { quoteId: 'quote', modelVersion: 'onenumber-trade-curve-v5', inputVersion: '1', createdAt: '2026-10-27T12:00:00Z', teams: [{ memberId: 'member-a', valuesSent: 100, valuesReceived: 120, impact: 20, shortTermPoints: 0, longTermValue: 0, packageEffect: 0, replacementEffect: 0, rosterSlotEffect: 0 }] } })
    let screen!: ReturnType<typeof create>
    await act(async () => { screen = create(React.createElement(SavedTradeEstimate, { trade: value, myMemberId: 'member-a' })) })
    const text = screen.root.findAllByType('Text' as React.ElementType).map(node => React.Children.toArray(node.props.children).join('')).join('\n')
    expect(text).toContain('Team A: 120 · Net +20')
    expect(text).toContain('Team A wins · 16.67% gap')
    expect(text).not.toMatch(/Saved |Saved estimate and sources/)
    await act(async () => screen.unmount())
})
