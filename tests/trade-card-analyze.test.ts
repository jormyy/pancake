import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { TradeCard } from '@/components/trades/TradeCard'
import { TradeOfferRow } from '@/components/trades/TradeListRow'
import type { Trade } from '@/lib/trades'

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    NativeModules: { BlobModule: null },
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }))
vi.mock('@/components/Badge', () => ({ Badge: 'Badge' }))
vi.mock('@/components/PosTag', () => ({ PosTag: 'PosTag' }))
vi.mock('@/components/SectionHeader', () => ({ SectionHeader: 'SectionHeader' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null, yearShort: String }))
vi.mock('@/lib/player-context', () => ({ playerEligiblePositions: () => [], playerSeasonContextText: () => '' }))
vi.mock('@/lib/trades', () => ({ needsMemberAcceptance: () => false }))
vi.mock('@/lib/trade-perspective', () => ({
    tradeDisplayPerspective: () => ({ receives: [], gives: [], receiveLabel: 'You receive', giveLabel: 'You give' }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const trade = {
    id: 'trade-1',
    status: 'completed',
    proposerMemberId: 'member-a',
    recipientMemberId: 'member-b',
    proposerTeamName: 'Team A',
    recipientTeamName: 'Team B',
    participants: [],
    isMultiTeam: false,
    routedItems: [],
    version: 1,
    notes: null,
    expiresAt: null,
    vetoWindowExpiresAt: null,
    myVetoed: false,
} as unknown as Trade

const ANALYZE = 'Analyze trade from Team A'

function cardProps(overrides: Partial<React.ComponentProps<typeof TradeCard>> = {}): React.ComponentProps<typeof TradeCard> {
    return {
        trade, myMemberId: 'member-a', tab: 'history', acting: false,
        onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(),
        ...overrides,
    }
}

describe('TradeCard analyze action', () => {
    it('lives in the card header beside the status and opens the analyzer', async () => {
        const onAnalyze = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TradeCard, cardProps({ onAnalyze }))) })

        const analyze = renderer.root.findByProps({ accessibilityLabel: ANALYZE })
        expect(analyze.props.accessibilityRole).toBe('button')
        expect(analyze.props.disabled).toBe(false)
        expect(analyze.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ minHeight: 44 })]))
        const controls = analyze.parent!
        expect(controls.findAllByProps({ children: 'Completed' }).length).toBeGreaterThan(0)
        const header = controls.parent!
        expect(header.findAllByProps({ children: 'Team B' }).length).toBeGreaterThan(0)

        await act(async () => { analyze.props.onPress() })
        expect(onAnalyze).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

    it('is disabled while another trade action is in flight', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TradeCard, cardProps({ onAnalyze: vi.fn(), acting: true }))) })
        const analyze = renderer.root.findByProps({ accessibilityLabel: ANALYZE })
        expect(analyze.props.disabled).toBe(true)
        expect(analyze.props.accessibilityState).toEqual({ disabled: true })
        await act(async () => { renderer.unmount() })
    })

    it('is absent when the card has no analyzer to open', async () => {
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(TradeCard, cardProps())) })
        expect(renderer.root.findAllByProps({ accessibilityLabel: ANALYZE })).toHaveLength(0)
        await act(async () => { renderer.unmount() })
    })

    it('trade rows render exactly one analyze control, inside the card', async () => {
        const onAnalyze = vi.fn()
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TradeOfferRow, {
                item: { _type: 'trade', trade }, myMemberId: 'member-a', tab: 'history', tradeVetoMode: 'member_vote',
                isCommissioner: false, acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                onWithdraw: vi.fn(), onAnalyze,
            }))
        })
        const controls = renderer.root.findAllByProps({ accessibilityLabel: ANALYZE }, { deep: false })
        expect(controls).toHaveLength(1)
        const rootJson = renderer.toJSON()
        expect(Array.isArray(rootJson)).toBe(false)
        const cardChildren = (rootJson as { children?: { props?: { accessibilityLabel?: string } }[] }).children ?? []
        expect(cardChildren.some((child) => child?.props?.accessibilityLabel === ANALYZE)).toBe(false)
        await act(async () => { controls[0].props.onPress() })
        expect(onAnalyze).toHaveBeenCalledWith(trade)
        await act(async () => { renderer.unmount() })
    })
})
