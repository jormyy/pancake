import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTradeActions } from '@/hooks/use-trade-actions'
import type { Trade } from '@/lib/trades'

const gameBoundary = vi.hoisted(() => ({ teams: new Set<string>() }))
vi.mock('@/lib/games', () => ({ getGameDay: async () => ({ games: [], startedTeams: gameBoundary.teams }) }))

const mocks = vi.hoisted(() => ({
    acceptTrade: vi.fn(),
    setTradeRosterPlan: vi.fn(),
    confirmAction: vi.fn(),
    rejectTrade: vi.fn(),
    vetoTrade: vi.fn(),
    withdrawTrade: vi.fn(),
}))

vi.mock('@/lib/trades', () => ({
    acceptTrade: mocks.acceptTrade,
    setTradeRosterPlan: mocks.setTradeRosterPlan,
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
    gameBoundary.teams.clear()
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => onConfirm())
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
    it('does not send or queue decisions after online authority is lost, including an open confirmation', async () => {
        let latest!: ReturnType<typeof useTradeActions>
        let confirm!: () => Promise<void>
        mocks.confirmAction.mockImplementation((_title, _message, action) => { confirm = action })
        const onAction = vi.fn()
        const Probe = ({ enabled }: { enabled: boolean }) => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', enabled, onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { enabled: true })) })
        act(() => { latest.reject('pending') })
        await act(async () => { renderer.update(React.createElement(Probe, { enabled: false })) })
        await act(async () => { await confirm(); await latest.accept(trade('pending')) })
        expect(mocks.rejectTrade).not.toHaveBeenCalled()
        expect(mocks.acceptTrade).not.toHaveBeenCalled()
        await act(async () => { renderer.update(React.createElement(Probe, { enabled: true })) })
        expect(mocks.acceptTrade).not.toHaveBeenCalled()
        expect(onAction).not.toHaveBeenCalled()
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => onConfirm())
        await act(async () => { await latest.accept(trade('pending')) })
        expect(mocks.acceptTrade).toHaveBeenCalledExactlyOnceWith('pending', 'member-a')
        expect(onAction).toHaveBeenCalledTimes(1)
        await act(async () => { renderer.unmount() })
    })

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

    it('does not refresh after an in-flight acceptance outlives the screen', async () => {
        const acceptance = deferred<void>()
        mocks.acceptTrade.mockReturnValue(acceptance.promise)
        const onAction = vi.fn()
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = () => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.accept(trade('trade-a')); await Promise.resolve() })
        await act(async () => { renderer.unmount() })
        await act(async () => { acceptance.resolve(); await pending })

        expect(onAction).not.toHaveBeenCalled()
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

    it('cancels a terminal confirmation after the screen unmounts', async () => {
        let confirm!: () => Promise<void>
        mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
        mocks.rejectTrade.mockResolvedValue(undefined)
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = () => {
            latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        await act(async () => { latest.reject('trade-a') })
        await act(async () => { renderer.unmount() })
        await act(async () => { await confirm() })

        expect(mocks.rejectTrade).not.toHaveBeenCalled()
    })
})


it('updates only the saved trade from the roster-plan response', async () => {
    const sent = { taxiPlayerIds: ['incoming'], irPlayerIds: [], dropPlayerIds: ['drop'] }
    const saved = { taxiPlayerIds: [], irPlayerIds: ['incoming'], dropPlayerIds: ['drop'] }
    mocks.setTradeRosterPlan.mockResolvedValue(saved)
    const onAction = vi.fn(() => new Promise<void>(() => {}))
    const onRosterPlanSaved = vi.fn()
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = () => {
        latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', onAction, onRosterPlanSaved })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { void latest.setRosterPlan(trade('trade-a'), sent); await Promise.resolve() })
    expect(mocks.setTradeRosterPlan).toHaveBeenCalledWith('trade-a', 'member-a', sent)
    expect(onRosterPlanSaved).toHaveBeenCalledExactlyOnceWith('trade-a', saved)
    expect(onAction).not.toHaveBeenCalled()
    expect(latest.busyTradeId).toBeNull()
    await act(async () => { renderer.unmount() })
})

it('ignores a saved roster plan after the member changes', async () => {
    const saving = deferred<{ taxiPlayerIds: string[]; irPlayerIds: string[]; dropPlayerIds: string[] }>()
    mocks.setTradeRosterPlan.mockReturnValue(saving.promise)
    const onRosterPlanSaved = vi.fn()
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = ({ memberId }: { memberId: string }) => {
        latest = useTradeActions({ memberId, leagueId: 'league-a', onAction: vi.fn(), onRosterPlanSaved })
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a' })) })
    let pending!: Promise<void>
    const plan = { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] }
    await act(async () => { pending = latest.setRosterPlan(trade('trade-a'), plan) })
    await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b' })) })
    await act(async () => { saving.resolve(plan); await pending })
    expect(onRosterPlanSaved).not.toHaveBeenCalled()
    await act(async () => { renderer.unmount() })
})

it.each([
    ['disabled', 24, true], ['member_vote', 0, true], ['commissioner', 0, true], ['member_vote', 24, false],
] as const)('confirms acceptance with its assets and execution timing: %s / %s', async (tradeVetoMode, tradeVetoWindowHours, immediate) => {
    let confirm!: () => Promise<void>
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
    mocks.acceptTrade.mockResolvedValue(undefined)
    let latest!: ReturnType<typeof useTradeActions>
    const onAction = vi.fn()
    const Probe = () => { latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', tradeVetoMode, tradeVetoWindowHours, onAction }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const offer = trade('offer')
    offer.routedItems.push({ kind: 'pick', pickId: 'pick', round: 1, seasonYear: 2027, originalTeamName: 'A', fromMemberId: 'member-a', toMemberId: 'other' },
        { kind: 'faab', amount: 5, fromMemberId: 'member-a', toMemberId: 'other' })
    await act(async () => { await latest.accept(offer) })
    expect(mocks.acceptTrade).not.toHaveBeenCalled()
    const [title, message] = mocks.confirmAction.mock.calls[0]
    expect(title).toBe('Accept trade?')
    expect(message).toContain('Incoming')
    expect(message).toContain('2026 Round 1 pick')
    expect(message).toContain('$5 FAAB')
    expect(message.includes('This trade completes immediately.')).toBe(immediate)
    expect(message).not.toContain('\n')
    await act(async () => { await confirm() })
    expect(mocks.acceptTrade).toHaveBeenCalledExactlyOnceWith('offer', 'member-a')
    expect(onAction).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
})

it.each(['owner', 'offline', 'unmount'])('cancels an open acceptance after %s changes', async change => {
    let confirm!: () => Promise<void>
    mocks.confirmAction.mockImplementation((_title, _message, onConfirm) => { confirm = onConfirm })
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = ({ member = 'member-a', enabled = true }: { member?: string; enabled?: boolean }) => {
        latest = useTradeActions({ memberId: member, leagueId: 'league-a', enabled, onAction: vi.fn() }); return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => { await latest.accept(trade('offer')) })
    expect(mocks.acceptTrade).not.toHaveBeenCalled()
    await act(async () => {
        if (change === 'unmount') renderer.unmount()
        else renderer.update(React.createElement(Probe, { member: change === 'owner' ? 'member-b' : 'member-a', enabled: change !== 'offline' }))
    })
    await act(async () => { await confirm() })
    expect(mocks.acceptTrade).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
})


it('does not promise immediate completion while another participant has not accepted', async () => {
    mocks.confirmAction.mockImplementation(() => {})
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = () => { latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', tradeVetoMode: 'disabled', onAction: vi.fn() }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    const offer = trade('multi')
    offer.isMultiTeam = true
    offer.participants = [{ memberId: 'third', teamName: 'Third', sortOrder: 2, isInitiator: false, acceptedAt: null }]
    await act(async () => latest.accept(offer))
    expect(mocks.confirmAction.mock.calls[0][1]).toContain('when everyone accepts')
    expect(mocks.confirmAction.mock.calls[0][1]).not.toContain('immediately')
    await act(async () => renderer.unmount())
})


it('opens roster resolution before confirming acceptance when the local gate finds a problem', async () => {
    const beforeAccept = vi.fn().mockResolvedValue(false)
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = () => { latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', beforeAccept, onAction: vi.fn() }); return null }
    let screen!: ReactTestRenderer
    await act(async () => { screen = create(React.createElement(Probe)) })
    await act(async () => latest.accept(trade('illegal')))
    expect(beforeAccept).toHaveBeenCalledOnce()
    expect(mocks.confirmAction).not.toHaveBeenCalled()
    expect(mocks.acceptTrade).not.toHaveBeenCalled()
    await act(async () => screen.unmount())
})


it('keeps acceptance timing conditional when a player game has started', async () => {
    gameBoundary.teams.add('LAL')
    mocks.confirmAction.mockImplementation(() => {})
    let latest!: ReturnType<typeof useTradeActions>
    const Probe = () => { latest = useTradeActions({ memberId: 'member-a', leagueId: 'league-a', tradeVetoMode: 'disabled', onAction: vi.fn() }); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    await act(async () => latest.accept(trade('game')))
    expect(mocks.confirmAction.mock.calls[0][1]).toContain('when everyone accepts')
    expect(mocks.confirmAction.mock.calls[0][1]).not.toContain('immediately')
    await act(async () => renderer.unmount())
})
