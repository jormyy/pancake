import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ParticipantTradePanel } from '@/components/trades/ParticipantTradePanel'
import { MAX_TRADE_FAAB_AMOUNT } from '@pancake/core'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}))
vi.mock('@/components/trades/TradeAssetColumn', () => ({ TradeAssetColumn: 'TradeAssetColumn' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderPanel = async (value: string, onFaabChange = vi.fn()) => {
    const participant: TradeParticipantView = {
        memberId: 'me',
        destinationIds: ['them'],
        defaultDestinationId: 'them',
        roster: [],
        picks: [],
        selectedPlayerIds: new Set(),
        selectedPickIds: new Set(),
        playerDestinationIds: {},
        pickDestinationIds: {},
        faabInputs: { them: value },
    }
    let renderer!: ReactTestRenderer
    await act(async () => {
        renderer = create(React.createElement(ParticipantTradePanel, {
            participant,
            myMemberId: 'me',
            faabEnabled: true,
            useColumns: false,
            avgMap: new Map(),
            avgStatsMap: new Map(),
            participantName: (memberId: string) => memberId,
            onTogglePlayer: vi.fn(),
            onTogglePick: vi.fn(),
            onDestinationChange: vi.fn(),
            onPlayerDestinationChange: vi.fn(),
            onPickDestinationChange: vi.fn(),
            onFaabChange,
        }))
    })
    return { renderer, onFaabChange }
}

describe('trade FAAB input', () => {
    it('accepts 1,000,000 and prevents increasing to 1,000,001', async () => {
        const { renderer, onFaabChange } = await renderPanel(String(MAX_TRADE_FAAB_AMOUNT))
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })

        expect(input.props['aria-invalid']).toBe(false)
        await act(async () => { input.props.onChangeText(String(MAX_TRADE_FAAB_AMOUNT + 1)) })
        expect(onFaabChange).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('announces an oversized prefill and allows reducing it to the maximum', async () => {
        const { renderer, onFaabChange } = await renderPanel(String(MAX_TRADE_FAAB_AMOUNT + 1))
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })
        const error = renderer.root.findByProps({ testID: 'trade-faab-error-me-them' })

        expect(input.props['aria-invalid']).toBe(true)
        expect(input.props.accessibilityLabel).toContain('FAAB amount cannot exceed 1,000,000.')
        expect(error.props.accessibilityRole).toBe('alert')
        await act(async () => { input.props.onChangeText(String(MAX_TRADE_FAAB_AMOUNT)) })
        expect(onFaabChange).toHaveBeenCalledWith('me', 'them', String(MAX_TRADE_FAAB_AMOUNT))
        await act(async () => { renderer.unmount() })
    })
})
