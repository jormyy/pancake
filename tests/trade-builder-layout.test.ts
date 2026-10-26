import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 402 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/trades/ParticipantTradePanel', () => ({ ParticipantTradePanel: () => null }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('keeps the deal summary in document flow so it cannot cover sender controls', async () => {
    const change = vi.fn()
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(MultiTeamTradeBuilder, {
        participants: [], items: [], myMemberId: 'me', faabEnabled: false, notes: '', notesError: null,
        expirationDays: '3', expirationError: null, rosterError: null, rosterLoading: false,
        avgMap: new Map(), avgStatsMap: new Map(), participantName: String, onRetry: change,
        onTogglePlayer: change, onTogglePick: change, onRemoveAsset: change, onDestinationChange: change,
        onPlayerDestinationChange: change, onPickDestinationChange: change, onFaabChange: change,
        onNotesChange: change, onExpirationDaysChange: change,
    })) })
    const summary = renderer.root.findByProps({ testID: 'trade-deal-summary' })
    const style = Object.assign({}, ...[summary.props.style].flat(Infinity).filter(Boolean))
    expect(style.position).not.toBe('sticky')
    expect(style.position).not.toBe('absolute')
    await act(async () => renderer.unmount())
})

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))
