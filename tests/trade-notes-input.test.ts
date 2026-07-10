import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { validateTradeNotes } from '@/lib/trade-composer'
import { MAX_TRADE_NOTES_BYTES } from '@pancake/core'
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
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
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
    const onNotesChange = vi.fn()
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
            onNotesChange,
            onExpirationDaysChange: vi.fn(),
        }))
    })
    return { renderer, onNotesChange }
}

describe('trade notes input', () => {
    it('uses measured content width for the compact builder layout', async () => {
        const { renderer } = await renderBuilder('')
        const root = renderer.root.findAll((node) => typeof node.props.onLayout === 'function')[0]
        const overviews = () => renderer.root.findAll((node) => String(node.type) === 'MultiTeamTradeOverview')

        expect(root).toBeDefined()
        expect(overviews()).toHaveLength(0)

        await act(async () => {
            root?.props.onLayout({ nativeEvent: { layout: { width: 700 } } })
        })

        const summary = renderer.root.findByProps({
            accessibilityLabel: 'Show deal summary. 2 teams and 0 routed assets.',
        })
        expect(summary.props.accessibilityState).toEqual({ expanded: false })
        expect(overviews()).toHaveLength(0)

        await act(async () => { summary.props.onPress() })
        expect(overviews()[0].props.compact).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('accepts and counts the 2,000-byte boundary', async () => {
        const { renderer, onNotesChange } = await renderBuilder('é'.repeat(1_000))
        const input = renderer.root.findByProps({ testID: 'trade-notes-input' })
        const count = renderer.root.findByProps({ testID: 'trade-notes-count' })

        expect(input.props.maxLength).toBeUndefined()
        expect(input.props['aria-invalid']).toBe(false)
        expect(count.props.children).toEqual([MAX_TRADE_NOTES_BYTES, ' / ', MAX_TRADE_NOTES_BYTES, ' bytes'])
        await act(async () => { input.props.onChangeText('é'.repeat(1_001)) })
        expect(onNotesChange).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('announces and counts an oversized edit or counter prefill', async () => {
        const { renderer, onNotesChange } = await renderBuilder('😀'.repeat(501))
        const input = renderer.root.findByProps({ testID: 'trade-notes-input' })
        const count = renderer.root.findByProps({ testID: 'trade-notes-count' })
        const error = renderer.root.findByProps({ testID: 'trade-notes-error' })

        expect(input.props['aria-invalid']).toBe(true)
        expect(input.props.accessibilityLabel).toContain('Notes must contain at most 2000 UTF-8 bytes.')
        expect(count.props.children).toEqual([2_004, ' / ', MAX_TRADE_NOTES_BYTES, ' bytes'])
        expect(error.props.accessibilityRole).toBe('alert')
        await act(async () => { input.props.onChangeText('😀'.repeat(500)) })
        expect(onNotesChange).toHaveBeenCalledWith('😀'.repeat(500))
        await act(async () => { renderer.unmount() })
    })
})
