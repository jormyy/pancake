import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeActions } from '@/hooks/use-trade-actions'
import type { Trade } from '@/lib/trades'

const mocks = vi.hoisted(() => ({
    acceptTrade: vi.fn(),
    confirmAction: vi.fn(),
    rejectTrade: vi.fn(),
    vetoTrade: vi.fn(),
    withdrawTrade: vi.fn(),
}))

vi.mock('@/lib/trades', () => ({
    acceptTrade: mocks.acceptTrade,
    rejectTrade: mocks.rejectTrade,
    vetoTrade: mocks.vetoTrade,
    withdrawTrade: mocks.withdrawTrade,
}))
vi.mock('@/lib/alert', () => ({
    confirmAction: mocks.confirmAction,
    getErrorMessage: (error: unknown) => String(error),
    showAlert: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
    vi.clearAllMocks()
})

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

const trade = (id: string): Trade => ({
    id,
    status: 'pending',
    proposedAt: '2026-07-09T10:00:00Z',
    acceptedAt: null,
    vetoWindowExpiresAt: null,
    completedAt: null,
    vetoedAt: null,
    expiresAt: null,
    notes: null,
    proposerMemberId: 'other',
    proposerTeamName: 'Other',
    recipientMemberId: 'member-a',
    recipientTeamName: 'A',
    isMultiTeam: false,
    participants: [],
    parentTradeId: null,
    counteredFromTradeId: null,
    editedFromTradeId: null,
    replacedByTradeId: null,
    version: 1,
    proposerFaabAmount: 0,
    recipientFaabAmount: 0,
    myVetoed: false,
    routedItems: [{
        kind: 'player', playerId: 'incoming', playerName: 'Incoming', position: 'PG',
        eligiblePositions: ['PG'], nbaTeam: 'LAL', nbaId: null, injuryStatus: null,
        yearsExp: 1, fromMemberId: 'other', toMemberId: 'member-a',
    }],
})

describe('useTradeActions', () => {
    it('accepts without a client-side roster-cap or drop workflow', async () => {
        mocks.acceptTrade.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useTradeActions>
        const onAction = vi.fn()
        const Probe = () => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { await latest.accept(trade('trade-a')) })

        expect(mocks.acceptTrade).toHaveBeenCalledWith('trade-a', 'member-a')
        expect(onAction).toHaveBeenCalledOnce()
        expect(latest.busyTradeId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('does not refresh a prior league after an in-flight acceptance changes owner', async () => {
        const acceptance = deferred<void>()
        mocks.acceptTrade.mockReturnValue(acceptance.promise)
        const onAction = vi.fn()
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradeActions({ memberId, leagueId, onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.accept(trade('trade-a')); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' })) })
        await act(async () => { acceptance.resolve(); await pending })

        expect(onAction).not.toHaveBeenCalled()
        expect(latest.busyTradeId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('serializes mutations so another trade cannot supersede or re-enable the first', async () => {
        const first = deferred<void>()
        mocks.acceptTrade.mockReturnValueOnce(first.promise)
        const onAction = vi.fn()
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = () => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let pending!: Promise<void>
        await act(async () => {
            pending = latest.accept(trade('trade-a'))
            await latest.accept(trade('trade-b'))
        })
        expect(mocks.acceptTrade).toHaveBeenCalledTimes(1)
        expect(latest.busyTradeId).toBe('trade-a')
        await act(async () => { first.resolve(); await pending })
        expect(onAction).toHaveBeenCalledOnce()
        expect(latest.busyTradeId).toBeNull()
        await act(async () => { renderer.unmount() })
    })

    it('cancels a terminal confirmation when the active owner changes', async () => {
        let confirm!: () => Promise<void>
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
        mocks.rejectTrade.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradeActions({ memberId, leagueId, onAction: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' }))
        })
        await act(async () => { latest.reject('trade-a') })
        await act(async () => {
            renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' }))
        })
        await act(async () => { await confirm() })

        expect(mocks.rejectTrade).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})
