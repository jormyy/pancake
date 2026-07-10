import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import type { PlayerRow } from '@/lib/players'
import type { RosterPlayer } from '@/lib/roster'

const mocks = vi.hoisted(() => ({
    loadGate: vi.fn(),
}))

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: vi.fn() }))
vi.mock('@/lib/roster-add-flow', () => ({
    addFreeAgentOrRequestDrop: vi.fn(),
    loadRosterAddGate: mocks.loadGate,
    resolveRosterAddIRConflict: vi.fn(),
}))
vi.mock('@/lib/waivers', () => ({ submitWaiverClaim: vi.fn() }))
vi.mock('@/lib/alert', () => ({ getErrorMessage: String }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

describe('useQuickAdd owner identity', () => {
    it('does not open an old league IR modal after the owner changes', async () => {
        const gate = deferred<{ roster: RosterPlayer[]; ineligible: RosterPlayer[] }>()
        mocks.loadGate.mockReturnValue(gate.promise)
        const player = { id: 'player-a', display_name: 'Player A' } as PlayerRow
        const staleRosterPlayer = {
            id: 'roster-a', is_on_ir: true, is_on_taxi: false, acquired_via: 'free_agent', players: player,
        } as unknown as RosterPlayer
        let latest!: ReturnType<typeof useQuickAdd>
        const Probe = ({ memberId, leagueId }: { memberId: string; leagueId: string }) => {
            latest = useQuickAdd(memberId, leagueId, 20, new Set(), vi.fn())
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { memberId: 'member-a', leagueId: 'league-a' })) })
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleAdd(player); await Promise.resolve() })
        await act(async () => { renderer.update(React.createElement(Probe, { memberId: 'member-b', leagueId: 'league-b' })) })
        await act(async () => {
            gate.resolve({ roster: [staleRosterPlayer], ineligible: [staleRosterPlayer] })
            await pending
        })

        expect(latest.irModal).toBeNull()
        expect(latest.dropPickerPlayer).toBeNull()
        expect(latest.myRoster).toEqual([])
        await act(async () => { renderer.unmount() })
    })
})
