import './helpers/native-component-mocks'
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TradeActionButtons, tradeCardModel } from '@/components/trades/TradeCard'
import { canWithdrawAcceptance } from '@/lib/trade-perspective'
import { useTradeActions } from '@/hooks/use-trade-actions'
import { RequestError } from '@/lib/shared/errors'
import { trade } from './helpers/fixtures'

vi.mock('@/lib/trades', () => ({
    acceptTrade: mocks.acceptTrade,
    getTradeRosterPreview: mocks.getTradeRosterPreview,
    retractTradeAcceptance: mocks.retractTradeAcceptance,
    setTradeRosterPlan: mocks.setTradeRosterPlan,
    rejectTrade: mocks.rejectTrade,
    vetoTrade: mocks.vetoTrade,
    withdrawTrade: mocks.withdrawTrade,
    needsMemberAcceptance: (offer: { status: string; participants: { memberId: string; acceptedAt: string | null }[] }, memberId: string) =>
        offer.status === 'pending' && offer.participants.some(participant => participant.memberId === memberId && participant.acceptedAt == null),
}))
vi.mock('@/lib/alert', () => ({ confirmAction: mocks.confirmAction, showAlert: mocks.showAlert }))
vi.mock('@/lib/trade-perspective', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/lib/trade-perspective')>(),
    tradeDisplayPerspective: () => ({ receives: [], gives: [], receiveLabel: 'You receive', giveLabel: 'You give' }),
}))

const mocks = vi.hoisted(() => ({
    acceptTrade: vi.fn(),
    getTradeRosterPreview: vi.fn(),
    retractTradeAcceptance: vi.fn(),
    setTradeRosterPlan: vi.fn(),
    rejectTrade: vi.fn(),
    vetoTrade: vi.fn(),
    withdrawTrade: vi.fn(),
    confirmAction: vi.fn(),
    showAlert: vi.fn(),
}))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => onConfirm())
})

const multi = (accepted: (string | null)[]) => trade({
    id: 'multi',
    status: 'pending',
    isMultiTeam: true,
    participants: accepted.map((acceptedAt, index) => ({
        memberId: index === 0 ? 'member-a' : `member-${index}`,
        teamName: index === 0 ? 'Team A' : `Team ${index}`,
        sortOrder: index,
        isInitiator: index === 0,
        acceptedAt,
    })),
})
const type = (value: string) => value as React.ElementType
const labels = (renderer: ReactTestRenderer) => renderer.root.findAllByType(type('Pressable')).map(node => node.props.accessibilityLabel)

describe('canWithdrawAcceptance', () => {
    it('allows an accepted team to retract while another team is still deciding', () => {
        expect(canWithdrawAcceptance(multi(['2026-08-27T00:00:00Z', null]), 'member-a')).toBe(true)
    })

    it('hides the action once every team has accepted', () => {
        expect(canWithdrawAcceptance(multi(['2026-08-27T00:00:00Z', '2026-08-27T01:00:00Z']), 'member-a')).toBe(false)
    })

    it('hides the action for a team that has not accepted', () => {
        expect(canWithdrawAcceptance(multi([null, '2026-08-27T01:00:00Z']), 'member-a')).toBe(false)
    })

    it('lets the proposer of a two-team offer retract the acceptance sent with the offer', () => {
        expect(canWithdrawAcceptance(trade({ status: 'pending' }), 'member-a')).toBe(true)
        expect(canWithdrawAcceptance(trade({ status: 'pending' }), 'member-b')).toBe(false)
    })

    it('hides the action outside the pending window', () => {
        expect(canWithdrawAcceptance(trade({ status: 'accepted' }), 'member-a')).toBe(false)
    })
})

describe('TradeActionButtons', () => {
    it('shows Withdraw acceptance while other teams decide and calls the retract action', async () => {
        const onWithdrawAcceptance = vi.fn()
        const offer = multi(['2026-08-27T00:00:00Z', null])
        const model = tradeCardModel({ trade: offer, myMemberId: 'member-a', tab: 'offers' })
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TradeActionButtons, {
                trade: offer, model, actions: {
                    acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                    onWithdraw: vi.fn(), onWithdrawAcceptance,
                },
            }))
        })
        const button = renderer.root.findByProps({ accessibilityLabel: 'Withdraw your acceptance of the trade with 2-team trade' })
        await act(async () => { button.props.onPress() })
        expect(onWithdrawAcceptance).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })

    it('hides Withdraw acceptance once the trade is unanimous', async () => {
        const offer = multi(['2026-08-27T00:00:00Z', '2026-08-27T01:00:00Z'])
        const model = tradeCardModel({ trade: offer, myMemberId: 'member-a', tab: 'offers' })
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TradeActionButtons, {
                trade: offer, model, actions: {
                    acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                    onWithdraw: vi.fn(), onWithdrawAcceptance: vi.fn(),
                },
            }))
        })
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Withdraw your acceptance of the trade with 2-team trade' })).toHaveLength(0)
        await act(async () => { renderer.unmount() })
    })

    it('hides Counter for the proposer after it retracts its acceptance', async () => {
        const offer = multi([null, '2026-08-27T01:00:00Z'])
        const model = tradeCardModel({ trade: offer, myMemberId: 'member-a', tab: 'offers' })
        expect(model.canRespond).toBe(true)
        expect(model.isProposer).toBe(true)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TradeActionButtons, {
                trade: offer, model, actions: {
                    acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                    onWithdraw: vi.fn(), onWithdrawAcceptance: vi.fn(),
                },
            }))
        })
        expect(labels(renderer)).toContain('Accept trade with 2-team trade')
        expect(labels(renderer)).not.toContain('Counter trade with 2-team trade')
        expect(labels(renderer)).toContain('Edit trade with 2-team trade')
        expect(labels(renderer)).toContain('Withdraw trade with 2-team trade')
        await act(async () => { renderer.unmount() })
    })

    it('keeps Counter for a team that did not propose the trade', async () => {
        const offer = multi([null, null])
        const model = tradeCardModel({ trade: offer, myMemberId: 'member-1', tab: 'offers' })
        expect(model.canRespond).toBe(true)
        expect(model.isProposer).toBe(false)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(TradeActionButtons, {
                trade: offer, model, actions: {
                    acting: false, onAccept: vi.fn(), onReject: vi.fn(), onVeto: vi.fn(),
                    onWithdraw: vi.fn(), onWithdrawAcceptance: vi.fn(),
                },
            }))
        })
        expect(labels(renderer)).toContain('Counter trade with 2-team trade')
        await act(async () => { renderer.unmount() })
    })
})

describe('useTradeActions retractAcceptance', () => {
    const mount = async (onAction: () => void | Promise<unknown>) => {
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = () => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        return { latest: () => latest, unmount: async () => { await act(async () => { renderer.unmount() }) } }
    }

    it('retracts the acceptance and refreshes the offer', async () => {
        mocks.retractTradeAcceptance.mockResolvedValue(undefined)
        const onAction = vi.fn()
        const { latest, unmount } = await mount(onAction)
        await act(async () => { await latest().retractAcceptance('multi') })
        expect(mocks.retractTradeAcceptance).toHaveBeenCalledWith('multi', 'member-a')
        expect(onAction).toHaveBeenCalledOnce()
        expect(mocks.showAlert).not.toHaveBeenCalled()
        expect(latest().busyTradeId).toBeNull()
        await unmount()
    })

    it('shows a stale withdrawal message and refreshes the offer', async () => {
        const message = 'Every team has accepted this trade, so acceptance can no longer be withdrawn.'
        mocks.retractTradeAcceptance.mockRejectedValue(new RequestError(message, { code: 'conflict' }))
        const onAction = vi.fn()
        const { latest, unmount } = await mount(onAction)
        await act(async () => { await latest().retractAcceptance('multi') })
        expect(mocks.showAlert).toHaveBeenCalledWith('Error', message)
        expect(onAction).toHaveBeenCalledOnce()
        expect(latest().busyTradeId).toBeNull()
        await unmount()
    })
})
