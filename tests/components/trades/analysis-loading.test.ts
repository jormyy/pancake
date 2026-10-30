import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import type { DynastyTradeAnalysis } from '@pancake/core'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Text: 'Text', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/components/player/PlayerRowContent', () => ({ PlayerRowContent: 'PlayerRowContent' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ ready, children }: { ready: boolean; children: React.ReactNode }) => ready ? children : null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const analysis: DynastyTradeAnalysis = { strategy: 'overall', assets: [], sources: [], confidence: 1, missingInputs: [], assumptions: [], teams: [
    { memberId: 'me', valuesSent: 10, valuesReceived: 25, impact: 15, shortTermPoints: 0, longTermValue: 0, packageEffect: 0, replacementEffect: 0, rosterSlotEffect: 0 },
] }
afterEach(async () => { await act(async () => screen?.unmount()) })
it('shows an accessible pending value until fresh analysis arrives', async () => {
    await act(async () => { screen = create(React.createElement(TradeAnalysisSummary, { analysis: null, loading: true, participantName: () => 'My team' })) })
    expect(screen.root.findByProps({ accessibilityLabel: 'Updating trade values' }).props['aria-busy']).toBe(true)
    expect(JSON.stringify(screen.toJSON())).toContain('Updating values')
    await act(async () => screen.update(React.createElement(TradeAnalysisSummary, { analysis, loading: false, participantName: () => 'My team' })))
    expect(screen.root.findAllByProps({ accessibilityLabel: 'Updating trade values' })).toHaveLength(0)
    expect(screen.root.findAllByType('Text' as React.ElementType).some(node => [node.props.children].flat().join('') === 'Received 25 · Sent 10 · Cuts 0')).toBe(true)
})
it('replaces obsolete totals with a loading status during revaluation', async () => {
    await act(async () => { screen = create(React.createElement(TradeAnalysisSummary, { analysis, loading: true, participantName: () => 'My team' })) })
    expect(screen.root.findByProps({ accessibilityLabel: 'Updating trade values' }).props['aria-busy']).toBe(true)
    expect(JSON.stringify(screen.toJSON())).not.toContain('Received 25')
})
