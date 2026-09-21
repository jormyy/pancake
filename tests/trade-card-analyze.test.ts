import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TradeCard } from '@/components/trades/TradeCard'
import { TradeOfferRow } from '@/components/trades/TradeListRow'
import { trade } from './helpers/fixtures'

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/SectionHeader', () => ({ SectionHeader: 'SectionHeader' }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/lib/format', () => ({ playerHeadshotUrl: () => null, yearShort: String }))
vi.mock('@/lib/player-context', () => ({ playerEligiblePositions: () => [], playerSeasonContextText: () => '' }))
vi.mock('@/lib/trades', () => ({ needsMemberAcceptance: () => false }))
vi.mock('@/lib/trade-perspective', () => ({
    tradeDisplayPerspective: () => ({ receives: [], gives: [], receiveLabel: 'You receive', giveLabel: 'You give' }),
}))

const completed = trade()
const ANALYZE = 'Analyze trade from Team A'
let renderer: ReactTestRenderer | null = null

afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

async function renderCard(overrides: Partial<React.ComponentProps<typeof TradeCard>> = {}) {
    await act(async () => {
        renderer = create(React.createElement(TradeCard, {
            trade: completed, myMemberId: 'member-a', tab: 'history', acting: false,
            onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(), onWithdraw: vi.fn(), onAnalyze: vi.fn(),
            ...overrides,
        }))
    })
    return renderer!
}

describe('TradeCard analyze action', () => {
    it('lives in the card header beside the status and opens the analyzer', async () => {
        const onAnalyze = vi.fn()
        const tree = await renderCard({ onAnalyze })

        const analyze = tree.root.findByProps({ accessibilityLabel: ANALYZE })
        expect(analyze.props.accessibilityRole).toBe('button')
        expect(analyze.props.disabled).toBe(false)
        expect(analyze.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ minHeight: 44 })]))
        const controls = analyze.parent!
        expect(controls.findAllByProps({ children: 'Completed' }).length).toBeGreaterThan(0)
        expect(controls.parent!.findAllByProps({ children: 'Team B' }).length).toBeGreaterThan(0)

        await act(async () => { analyze.props.onPress() })
        expect(onAnalyze).toHaveBeenCalledTimes(1)
    })

    it('is disabled while another trade action is in flight', async () => {
        const tree = await renderCard({ onAnalyze: vi.fn(), acting: true })
        const analyze = tree.root.findByProps({ accessibilityLabel: ANALYZE })
        expect(analyze.props.disabled).toBe(true)
        expect(analyze.props.accessibilityState).toEqual({ disabled: true })
    })

    it('trade rows render exactly one analyze control, inside the card', async () => {
        const onAnalyze = vi.fn()
        await act(async () => {
            renderer = create(React.createElement(TradeOfferRow, {
                item: { _type: 'trade', trade: completed }, myMemberId: 'member-a', tab: 'history', tradeVetoMode: 'member_vote',
                isCommissioner: false, acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                onWithdraw: vi.fn(), onAnalyze,
            }))
        })
        const controls = renderer!.root.findAllByProps({ accessibilityLabel: ANALYZE }, { deep: false })
        expect(controls).toHaveLength(1)
        const rootJson = renderer!.toJSON()
        expect(Array.isArray(rootJson)).toBe(false)
        const cardChildren = (rootJson as { children?: { props?: { accessibilityLabel?: string } }[] }).children ?? []
        expect(cardChildren.some((child) => child?.props?.accessibilityLabel === ANALYZE)).toBe(false)
        await act(async () => { controls[0].props.onPress() })
        expect(onAnalyze).toHaveBeenCalledWith(completed)
    })
})
