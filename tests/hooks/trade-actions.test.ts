import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useTradeActions } from '@/hooks/use-trade-actions'
import type { Trade } from '@/lib/trades'

const { acceptTrade, getRoster } = vi.hoisted(() => ({
    acceptTrade: vi.fn(),
    getRoster: vi.fn(),
}))

vi.mock('@/lib/trades', () => ({
    acceptTrade,
    rejectTrade: vi.fn(),
    vetoTrade: vi.fn(),
    withdrawTrade: vi.fn(),
}))
vi.mock('@/lib/roster', () => ({ getRoster }))
vi.mock('@/lib/alert', () => ({
    confirmAction: vi.fn(),
    getErrorMessage: (error: unknown) => String(error),
    showAlert: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const rosterPlayer = (id: string) => ({
    id: `roster-${id}`,
    member_id: 'member-a',
    is_on_ir: false,
    is_on_taxi: false,
    acquired_via: 'draft',
    players: {
        id, display_name: id, nba_team: 'LAL', position: 'PG', eligible_positions: ['PG'],
        injury_status: null, nba_id: null, nba_draft_number: null, years_exp: 1,
    },
})

describe('useTradeActions', () => {
    it('discards an overflow workflow when the owning league/member changes', async () => {
        const roster = deferred<ReturnType<typeof rosterPlayer>[]>()
        getRoster.mockReturnValue(roster.promise)
        let latest!: ReturnType<typeof useTradeActions>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useTradeActions({ memberId, leagueId, rosterSize: 1, onAction: vi.fn() })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.accept(trade('trade-a')); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' })) })
        await act(async () => { roster.resolve([rosterPlayer('one')]); await pending })

        expect(latest.dropPicker).toBeNull()
        expect(latest.busyTradeId).toBeNull()
        expect(acceptTrade).not.toHaveBeenCalled()
        await act(async () => { renderer.unmount() })
    })
})
