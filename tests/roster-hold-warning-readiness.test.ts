import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TradeActionButtons, tradeCardModel } from '@/components/trades/TradeCard'
import { RosterHoldWarning } from '@/components/roster/RosterHoldWarning'
import { useRosterHoldReady } from '@/hooks/use-roster-hold-ready'
import { useRosterHoldCheck } from '@/hooks/use-roster-hold-check'
import { useTradeActions } from '@/hooks/use-trade-actions'
import { RequestError } from '@/lib/shared/errors'
import { trade } from './helpers/fixtures'

const mocks = vi.hoisted(() => ({ apiPost: vi.fn(), apiReadPost: vi.fn(), confirm: vi.fn(), alert: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => false }) }))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.apiPost, apiReadPost: mocks.apiReadPost }))
vi.mock('@/lib/alert', () => ({ confirmAction: mocks.confirm, showAlert: mocks.alert, showSuccess: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, NativeModules: { BlobModule: null }, StyleSheet: { create: (styles: unknown) => styles }, Image: 'Image', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View', Modal: 'Modal', ScrollView: 'ScrollView' }))
vi.mock('@/components/Motion', () => ({
    MotionPressable: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Pressable', props, children),
    MotionView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('View', props, children),
}))
vi.mock('@/components/Avatar', () => ({ Avatar: (props: Record<string, unknown>) => React.createElement('Avatar', props) }))
vi.mock('@/components/trades/MultiTeamTradeOverview', () => ({ MultiTeamTradeOverview: () => null }))
vi.mock('@/components/trades/SavedTradeEstimate', () => ({ SavedTradeEstimate: () => null }))

const type = (value: string) => value as React.ElementType
const labelsOf = (renderer: ReactTestRenderer) => renderer.root.findAllByType(type('Pressable')).map(node => node.props.accessibilityLabel)
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

const offerFor = (acceptedMember: string, waitingMember: string) => trade({
    id: 'trade-1',
    status: 'pending',
    isMultiTeam: true,
    proposerMemberId: acceptedMember,
    participants: [
        { memberId: acceptedMember, teamName: 'Team A', sortOrder: 0, isInitiator: true, acceptedAt: '2026-08-27T00:00:00Z' },
        { memberId: waitingMember, teamName: 'Team B', sortOrder: 1, isInitiator: false, acceptedAt: null },
        { memberId: `${waitingMember}-c`, teamName: 'Team C', sortOrder: 2, isInitiator: false, acceptedAt: null },
    ],
})

const conflict = {
    tradeId: 'trade-1',
    version: 2,
    holderTeamName: 'Team A',
    partnerTeamNames: ['Team B'],
    canWithdraw: true,
    message: 'Your accepted trade with Team B needs this roster spot. Add a drop or undo your acceptance.',
}

function TradeProbe({ offer, memberId }: { offer: ReturnType<typeof trade>; memberId: string }) {
    const holdReady = useRosterHoldReady(memberId)
    const actions = useTradeActions({ memberId, leagueId: 'league', onAction: () => undefined })
    const model = tradeCardModel({ trade: offer, myMemberId: memberId, tab: 'offers', holdReady })
    return React.createElement(TradeActionButtons, { trade: offer, model, actions: {
        acting: actions.busyTradeId !== null,
        onAccept: vi.fn(),
        onReject: vi.fn(),
        onVeto: vi.fn(),
        onWithdraw: vi.fn(),
        onUndoAcceptance: () => actions.undoAcceptance(offer),
    } })
}

function ClaimProbe({ memberId }: { memberId: string }) {
    const hold = useRosterHoldCheck({ memberId, addPlayerId: 'target' })
    return React.createElement(RosterHoldWarning, { conflicts: hold.conflicts, onUndoAcceptance: hold.undoAcceptance,
        undoingTradeId: hold.undoingTradeId, notice: hold.undoNotice })
}

let renderer: ReactTestRenderer | undefined
beforeEach(() => {
    vi.clearAllMocks()
    mocks.confirm.mockImplementation((_title, _message, onConfirm) => onConfirm())
    mocks.apiPost.mockResolvedValue({ ok: true, tradeId: 'trade-1' })
})
afterEach(async () => { if (renderer) await act(async () => { renderer?.unmount() }); renderer = undefined })

describe('old backend without the roster-hold endpoints', () => {
    it('keeps the old trade card and claim warning and never retracts', async () => {
        mocks.apiReadPost.mockRejectedValue(new RequestError('Not found', { code: 'not_found' }))
        const offer = offerFor('old-a', 'old-b')

        await act(async () => { renderer = create(React.createElement(TradeProbe, { offer, memberId: 'old-a' })) })
        await flush()
        expect(labelsOf(renderer!)).not.toContain('Undo your acceptance of the trade with 3-team trade')
        await act(async () => { renderer!.unmount() })
        renderer = undefined

        await act(async () => { renderer = create(React.createElement(TradeProbe, { offer, memberId: 'old-b' })) })
        await flush()
        expect(labelsOf(renderer!)).toContain('Accept trade with 3-team trade')
        expect(labelsOf(renderer!)).toContain('Reject trade with 3-team trade')
        expect(labelsOf(renderer!)).toContain('Counter trade with 3-team trade')
        await act(async () => { renderer!.unmount() })
        renderer = undefined

        await act(async () => { renderer = create(React.createElement(ClaimProbe, { memberId: 'old-a' })) })
        await flush()
        expect(JSON.stringify(renderer!.toJSON())).not.toContain(conflict.message)
        expect(labelsOf(renderer!)).not.toContain('Undo acceptance of the trade with Team B')
        expect(mocks.apiPost).not.toHaveBeenCalled()
    })
})

describe('ready backend with the roster-hold endpoints', () => {
    it('shows Undo acceptance and sends the undo with the offer version while the other actions stay put', async () => {
        mocks.apiReadPost.mockImplementation(async (path: string, body: { addPlayerId?: string }) => {
            if (path !== '/waivers/roster-hold-check') throw new Error(`unexpected ${path}`)
            return body.addPlayerId ? { conflicts: [conflict] } : { conflicts: [] }
        })
        const offer = offerFor('ready-a', 'ready-b')

        await act(async () => { renderer = create(React.createElement(TradeProbe, { offer, memberId: 'ready-a' })) })
        await flush()
        expect(labelsOf(renderer!)).toContain('Undo your acceptance of the trade with 3-team trade')
        await act(async () => {
            renderer!.root.findAllByType(type('Pressable'))
                .find(node => node.props.accessibilityLabel === 'Undo your acceptance of the trade with 3-team trade')!
                .props.onPress()
        })
        await flush()
        expect(mocks.apiPost).toHaveBeenCalledWith('/trades/trade-1/retract-acceptance', { memberId: 'ready-a', version: 1 })
        await act(async () => { renderer!.unmount() })
        renderer = undefined

        await act(async () => { renderer = create(React.createElement(TradeProbe, { offer, memberId: 'ready-b' })) })
        await flush()
        expect(labelsOf(renderer!)).toContain('Accept trade with 3-team trade')
        expect(labelsOf(renderer!)).toContain('Reject trade with 3-team trade')
        expect(labelsOf(renderer!)).toContain('Counter trade with 3-team trade')
        await act(async () => { renderer!.unmount() })
        renderer = undefined

        await act(async () => { renderer = create(React.createElement(ClaimProbe, { memberId: 'ready-a' })) })
        await flush()
        expect(JSON.stringify(renderer!.toJSON())).toContain(conflict.message)
        expect(labelsOf(renderer!)).toContain('Undo acceptance of the trade with Team B')
        await act(async () => {
            renderer!.root.findAllByType(type('Pressable'))
                .find(node => node.props.accessibilityLabel === 'Undo acceptance of the trade with Team B')!
                .props.onPress()
        })
        await flush()
        expect(mocks.apiPost).toHaveBeenCalledWith('/trades/trade-1/retract-acceptance', { memberId: 'ready-a', version: 2 })
    })
})
