import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import type { TradeParticipantView } from '@/lib/trade-ui-model'
vi.mock('@/hooks/use-league-timezone', () => ({ useLeagueTimezone: () => 'America/Los_Angeles' }))

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View',
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 402 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/components/ui/DeferredContent', () => ({ DeferredContent: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('@/components/trades/ParticipantTradePanel', () => ({ ParticipantTradePanel: 'ParticipantTradePanel' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const participant = (memberId: string): TradeParticipantView => ({
    memberId, destinationIds: [], defaultDestinationId: '', roster: [], picks: [],
    selectedPlayerIds: new Set(), selectedPickIds: new Set(), playerDestinationIds: {}, pickDestinationIds: {}, faabInputs: {},
})

const render = async () => {
    const change = vi.fn()
    let renderer!: ReturnType<typeof create>
    await act(async () => { renderer = create(React.createElement(MultiTeamTradeBuilder, {
        participants: ['me', 'them', 'other'].map(participant),
        items: [{ kind: 'player', playerId: 'player', fromMemberId: 'me', toMemberId: 'them' }],
        myMemberId: 'me', faabEnabled: false, notes: '', notesError: null, expirationDays: '3', expirationError: null,
        rosterError: null, rosterLoading: false, avgMap: new Map(), avgStatsMap: new Map(), participantName: String, onRetry: change,
        onTogglePlayer: change, onTogglePick: change, onRemoveAsset: change,
        onPlayerDestinationChange: change, onPickDestinationChange: change, onFaabChange: change,
        onNotesChange: change, onExpirationDaysChange: change,
    })) })
    return renderer
}

it('stacks one card per team, you first, then the offer terms', async () => {
    const renderer = await render()
    const panels = renderer.root.findAllByType('ParticipantTradePanel' as React.ElementType)
    expect(panels.map(panel => panel.props.participant.memberId)).toEqual(['me', 'them', 'other'])
    const terms = renderer.root.findByProps({ accessibilityLabel: 'Offer terms' })
    const stack = panels[0].parent!
    const children = stack.children.filter(child => typeof child !== 'string')
    expect(children.indexOf(panels[2])).toBeLessThan(children.findIndex(child => typeof child !== 'string' && child.findAll(node => node === terms).length > 0))
    await act(async () => renderer.unmount())
})

it('has no separate analyze step or sender tabs', async () => {
    const renderer = await render()
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Analyze trade proposal' })).toHaveLength(0)
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'tab')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ testID: 'trade-deal-summary' })).toHaveLength(0)
    await act(async () => renderer.unmount())
})
