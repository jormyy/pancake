import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { validateTradeNotes } from '@/lib/trade-composer'
import { MAX_TRADE_NOTES_LENGTH } from '@pancake/core'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    TextInput: 'TextInput',
    useWindowDimensions: () => ({ width: 1_024, height: 768 }),
    View: 'View',
}))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: 'MultiTeamTradeOverview' }))
vi.mock('@/components/trades/ParticipantTradePanel', () => ({ ParticipantTradePanel: 'ParticipantTradePanel' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const participant = (memberId: string, destinationId: string): TradeParticipantView => ({
    memberId,
    destinationIds: [destinationId],
    defaultDestinationId: destinationId,
    roster: [],
    picks: [],
    selectedPlayerIds: new Set(),
    selectedPickIds: new Set(),
    playerDestinationIds: {},
    pickDestinationIds: {},
    faabInputs: {},
})

const renderBuilder = async (notes: string) => {
    let renderer!: ReactTestRenderer
    await act(async () => {
        renderer = create(React.createElement(MultiTeamTradeBuilder, {
            participants: [participant('me', 'them'), participant('them', 'me')],
            items: [],
            myMemberId: 'me',
            faabEnabled: true,
            notes,
            notesError: validateTradeNotes(notes).error,
            expirationDays: '3',
            expirationError: null,
            rosterError: null,
            rosterLoading: false,
            avgMap: new Map(),
            avgStatsMap: new Map(),
            participantName: (memberId: string) => memberId,
            onRetry: vi.fn(),
            onTogglePlayer: vi.fn(),
            onTogglePick: vi.fn(),
            onDestinationChange: vi.fn(),
            onPlayerDestinationChange: vi.fn(),
            onPickDestinationChange: vi.fn(),
            onFaabChange: vi.fn(),
            onNotesChange: vi.fn(),
            onExpirationDaysChange: vi.fn(),
        }))
    })
    return renderer
}

describe('trade notes input', () => {
    it('accepts and counts the 2,000-character boundary', async () => {
        const renderer = await renderBuilder('n'.repeat(MAX_TRADE_NOTES_LENGTH))
        const input = renderer.root.findByProps({ testID: 'trade-notes-input' })
        const count = renderer.root.findByProps({ testID: 'trade-notes-count' })

        expect(input.props.maxLength).toBe(MAX_TRADE_NOTES_LENGTH)
        expect(input.props['aria-invalid']).toBe(false)
        expect(count.props.children).toEqual([MAX_TRADE_NOTES_LENGTH, ' / ', MAX_TRADE_NOTES_LENGTH])
        await act(async () => { renderer.unmount() })
    })

    it('announces and counts an oversized edit or counter prefill', async () => {
        const renderer = await renderBuilder('n'.repeat(MAX_TRADE_NOTES_LENGTH + 1))
        const input = renderer.root.findByProps({ testID: 'trade-notes-input' })
        const count = renderer.root.findByProps({ testID: 'trade-notes-count' })
        const error = renderer.root.findByProps({ testID: 'trade-notes-error' })

        expect(input.props['aria-invalid']).toBe(true)
        expect(input.props.accessibilityLabel).toContain('Notes must contain at most 2000 characters.')
        expect(count.props.children).toEqual([MAX_TRADE_NOTES_LENGTH + 1, ' / ', MAX_TRADE_NOTES_LENGTH])
        expect(error.props.accessibilityRole).toBe('alert')
        await act(async () => { renderer.unmount() })
    })
})
