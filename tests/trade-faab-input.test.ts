import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ParticipantTradePanel } from '@/components/trades/ParticipantTradePanel'
import { MAX_TRADE_FAAB_DIGITS } from '@/lib/multi-team-trade-state'
import { MAX_TRADE_FAAB_AMOUNT } from '@pancake/core'
import type { TradeParticipantView } from '@/lib/trade-ui-model'

const navigation = vi.hoisted(() => ({ focused: true }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => navigation.focused }))
vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    StyleSheet: { create: <Value,>(value: Value) => value },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View',
}))
vi.mock('@/components/trades/TradeAssetColumn', () => ({ TradeAssetColumn: 'TradeAssetColumn' }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: 'Sheet' }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const renderPanel = async (value: string, onFaabChange = vi.fn(), selectedPlayerIds = new Set<string>(), onTogglePlayer = vi.fn(), onTogglePick = vi.fn()) => {
    const participant: TradeParticipantView = {
        memberId: 'me',
        destinationIds: ['them'],
        defaultDestinationId: 'them',
        roster: [],
        picks: [],
        selectedPlayerIds,
        selectedPickIds: new Set(),
        playerDestinationIds: {},
        pickDestinationIds: {},
        faabInputs: { them: value },
    }
    let renderer!: ReactTestRenderer
    const element = () => React.createElement(ParticipantTradePanel, {
        participant,
        myMemberId: 'me',
        faabEnabled: true,
        avgMap: new Map(),
        avgStatsMap: new Map(),
        participantName: (memberId: string) => memberId,
        onTogglePlayer,
        onTogglePick,
        blockedPlayerIds: new Set<string>(),
        blockedPickIds: new Set<string>(),
        onPlayerDestinationChange: vi.fn(),
        onPickDestinationChange: vi.fn(),
        onFaabChange,
    })
    await act(async () => { renderer = create(element()) })
    const rerender = () => act(async () => { renderer.update(element()) })
    return { renderer, onFaabChange, rerender }
}

const openAddSheet = async (renderer: ReactTestRenderer) => {
    await act(async () => { renderer.root.findByProps({ testID: 'trade-add-assets-me' }).props.onPress() })
}

const proposalText = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => (node.type as unknown) === 'Text')
    .map((node) => node.children.join(''))

function fabricReplacement(
    maxLength: number,
    currentValue: string,
    replacedLength: number,
    replacement: string,
): string | null {
    const allowedLength = maxLength - currentValue.length + replacedLength
    if (allowedLength <= 0) return null
    return allowedLength > replacement.length ? replacement : replacement.slice(0, allowedLength)
}

describe('trade FAAB input', () => {
    it('shows only the add action on an empty side and keeps zero FAAB out of the proposal', async () => {
        for (const value of ['', '0']) {
            const { renderer } = await renderPanel(value)
            expect(renderer.root.findAll((node) => (node.type as unknown) === 'TextInput')).toHaveLength(0)
            expect(proposalText(renderer)).toEqual(['You send', 'Add players, picks or FAAB'])
            await openAddSheet(renderer)
            expect(proposalText(renderer).slice(-2)).toEqual(['FAAB', 'To them'])
            expect(renderer.root.findByProps({ testID: 'trade-faab-me-them' }).props.value).toBe(value)
            await act(async () => { renderer.unmount() })
        }
    })

    it('lists positive FAAB in the proposal, edits it in Add and removes it back to empty', async () => {
        const { renderer, onFaabChange } = await renderPanel('25')
        expect(proposalText(renderer)).toEqual(['You send', '$', '$25 FAAB', 'to them', 'Remove', 'Add players, picks or FAAB'])
        await act(async () => { renderer.root.findByProps({ testID: 'trade-faab-edit-me-them' }).props.onPress() })
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })
        expect(input.props.value).toBe('25')
        await act(async () => { input.props.onChangeText('40') })
        expect(onFaabChange).toHaveBeenLastCalledWith('me', 'them', '40')
        await act(async () => { renderer.root.findByProps({ testID: 'trade-remove-me-faab-them' }).props.onPress() })
        expect(onFaabChange).toHaveBeenLastCalledWith('me', 'them', '')
        await act(async () => { renderer.unmount() })
    })

    it('accepts 1,000,000 and prevents increasing to 1,000,001', async () => {
        const { renderer, onFaabChange } = await renderPanel(String(MAX_TRADE_FAAB_AMOUNT))
        await openAddSheet(renderer)
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })

        expect(input.props['aria-invalid']).toBe(false)
        expect(input.props.maxLength).toBe(MAX_TRADE_FAAB_DIGITS)
        await act(async () => { input.props.onChangeText(String(MAX_TRADE_FAAB_AMOUNT + 1)) })
        expect(onFaabChange).not.toHaveBeenCalled()
        await act(async () => { input.props.onChangeText('9'.repeat(100_000)) })
        expect(onFaabChange).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })

    it('announces a historical oversized prefill and allows monotonic recovery', async () => {
        const historicalPrefill = '2147483647'
        const { renderer, onFaabChange } = await renderPanel(historicalPrefill)
        await openAddSheet(renderer)
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })
        const error = renderer.root.findByProps({ testID: 'trade-faab-error-me-them' })

        expect(input.props['aria-invalid']).toBe(true)
        expect(input.props.maxLength).toBe(historicalPrefill.length)
        expect(input.props.accessibilityLabel).toContain('FAAB amount cannot exceed 1,000,000.')
        expect(error.props.accessibilityRole).toBe('alert')
        expect(fabricReplacement(input.props.maxLength, historicalPrefill, 1, '')).toBe('')
        await act(async () => { input.props.onChangeText('214748364') })
        expect(onFaabChange).toHaveBeenCalledWith('me', 'them', '214748364')
        onFaabChange.mockClear()
        await act(async () => { input.props.onChangeText('3147483647') })
        await act(async () => { input.props.onChangeText('9'.repeat(100_000)) })
        expect(onFaabChange).not.toHaveBeenCalled()
        await act(async () => { input.props.onChangeText(String(MAX_TRADE_FAAB_AMOUNT)) })
        expect(onFaabChange).toHaveBeenCalledWith('me', 'them', String(MAX_TRADE_FAAB_AMOUNT))
        await act(async () => { renderer.unmount() })
    })

    it('keeps the native paste cap at the canonical digit count for normal values', async () => {
        const { renderer } = await renderPanel('')
        await openAddSheet(renderer)
        const input = renderer.root.findByProps({ testID: 'trade-faab-me-them' })

        expect(input.props.maxLength).toBe(MAX_TRADE_FAAB_DIGITS)
        expect(fabricReplacement(input.props.maxLength, '', 0, '99999999')).toBe('9999999')
        await act(async () => { renderer.unmount() })
    })
})

describe('trade asset picker', () => {
    const sheet = (renderer: ReactTestRenderer) => renderer.root.findAll((node) => (node.type as unknown) === 'Sheet')[0]
    const column = (renderer: ReactTestRenderer) => renderer.root.findByType('TradeAssetColumn' as React.ElementType)

    it('adds a player once and closes, while removing a player or choosing a pick keeps the picker open', async () => {
        const onTogglePlayer = vi.fn()
        const onTogglePick = vi.fn()
        const { renderer } = await renderPanel('', vi.fn(), new Set(['kept']), onTogglePlayer, onTogglePick)
        await openAddSheet(renderer)
        await act(async () => { column(renderer).props.onTogglePlayer('kept') })
        await act(async () => { column(renderer).props.onTogglePick('pick-1') })
        expect(sheet(renderer).props.visible).toBe(true)
        await act(async () => {
            column(renderer).props.onTogglePlayer('new')
            column(renderer).props.onTogglePlayer('new')
        })
        expect(sheet(renderer).props.visible).toBe(false)
        expect(onTogglePlayer.mock.calls).toEqual([['me', 'kept'], ['me', 'new']])
        expect(onTogglePick.mock.calls).toEqual([['me', 'pick-1']])
        await openAddSheet(renderer)
        expect(sheet(renderer).props.visible).toBe(true)
        await act(async () => { renderer.unmount() })
    })

    it('suspends the open picker while a player profile covers the trade and resumes it on return', async () => {
        const { renderer, rerender } = await renderPanel('')
        await openAddSheet(renderer)
        navigation.focused = false
        await rerender()
        expect(sheet(renderer).props).toMatchObject({ visible: true, suspended: true })
        navigation.focused = true
        await rerender()
        expect(sheet(renderer).props).toMatchObject({ visible: true, suspended: false })
        await act(async () => { renderer.unmount() })
    })
})

vi.mock('@/lib/shared/api', () => ({ API_URL: 'http://127.0.0.1:54321/functions/v1/api' }))
