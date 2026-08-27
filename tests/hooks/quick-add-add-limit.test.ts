import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import type { MemberTransactionState } from '@/lib/league'
import type { PlayerRow } from '@/lib/players'
import type { RosterPlayer } from '@/lib/roster'

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    loadGate: vi.fn(),
    addOrRequestDrop: vi.fn(),
    dropAndAdd: vi.fn(),
    submitClaim: vi.fn(),
}))

vi.mock('react-native', () => ({ Alert: { alert: mocks.alert } }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: mocks.dropAndAdd }))
vi.mock('@/lib/roster-add-flow', () => ({
    addFreeAgentOrRequestDrop: mocks.addOrRequestDrop,
    loadRosterAddGate: mocks.loadGate,
    resolveRosterAddIRConflict: vi.fn(),
}))
vi.mock('@/lib/waivers', () => ({ submitWaiverClaim: mocks.submitClaim }))
vi.mock('@/lib/alert', () => ({ getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = { id: 'player-a', display_name: 'Player A' } as PlayerRow
const rosterPlayer = { id: 'roster-a', is_on_ir: false, is_on_taxi: false, acquired_via: 'draft', players: player } as unknown as RosterPlayer
const futureReset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
const pastReset = new Date(Date.now() - 60 * 1000).toISOString()

const state = (overrides: Partial<MemberTransactionState> = {}): MemberTransactionState => ({
    leagueSeasonId: 'season', weekNumber: 4, weeklyAddLimit: 3, weeklyAddCount: 3, waiverMode: 'faab',
    faabStartingBudget: 100, faabBalance: 40, addLimitResetsAt: futureReset, addWeekTimeZone: 'America/New_York',
    ...overrides,
})

type Latest = ReturnType<typeof useQuickAdd>

async function mount(transactionState: MemberTransactionState | null, refreshTransactionState = vi.fn()) {
    let latest!: Latest
    const Probe = () => {
        latest = useQuickAdd('member-a', 'league-a', 20, new Set(), vi.fn(), refreshTransactionState, transactionState)
        return null
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    return { get latest() { return latest }, renderer, refreshTransactionState }
}

describe('useQuickAdd weekly add limit', () => {
    beforeEach(() => {
        mocks.alert.mockReset()
        mocks.loadGate.mockReset()
        mocks.addOrRequestDrop.mockReset()
        mocks.dropAndAdd.mockReset()
        mocks.submitClaim.mockReset()
    })

    it('explains a used-up week before calling the server', async () => {
        const probe = await mount(state())
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.loadGate).not.toHaveBeenCalled()
        expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
        expect(mocks.alert).toHaveBeenCalledTimes(1)
        const [title, message] = mocks.alert.mock.calls[0]
        expect(title).toBe('Weekly add limit reached')
        expect(message).toMatch(/^You've used all 3 of this week's adds\. Adds reset .* ET/)
        expect(probe.refreshTransactionState).toHaveBeenCalled()
        await act(async () => { probe.renderer.unmount() })
    })

    it('proceeds once the reported week has ended, even if the cached count is full', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'added' })
        const probe = await mount(state({ addLimitResetsAt: pastReset }))
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.addOrRequestDrop).toHaveBeenCalledWith('member-a', 'league-a', 'player-a')
        expect(mocks.alert).toHaveBeenCalledWith('Added', 'Player A added to your roster.')
        await act(async () => { probe.renderer.unmount() })
    })

    it('shows the server reset message and closes the drop picker when the last slot went elsewhere', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [rosterPlayer], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'roster_full', activeRoster: [rosterPlayer] })
        const probe = await mount(state({ weeklyAddCount: 2 }))
        await act(async () => { await probe.latest.handleAdd(player) })
        expect(probe.latest.dropPickerPlayer).toEqual(player)

        mocks.dropAndAdd.mockRejectedValue(new Error('Weekly add limit reached (3/3 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.'))
        await act(async () => { await probe.latest.handleDropAndAdd(rosterPlayer) })

        expect(mocks.alert).toHaveBeenLastCalledWith(
            'Weekly add limit reached',
            'Weekly add limit reached (3/3 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.',
        )
        expect(probe.latest.dropPickerPlayer).toBeNull()
        expect(probe.refreshTransactionState).toHaveBeenCalled()
        await act(async () => { probe.renderer.unmount() })
    })

    it('keeps other server errors on the generic path', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockRejectedValue(new Error('This player is on waivers - submit a waiver claim instead.'))
        const probe = await mount(state({ weeklyAddCount: 1 }))
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.alert).toHaveBeenCalledWith('Error', 'This player is on waivers - submit a waiver claim instead.')
        await act(async () => { probe.renderer.unmount() })
    })

    it('does nothing special for unlimited leagues', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'added' })
        const probe = await mount(state({ weeklyAddLimit: null, weeklyAddCount: 40 }))
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.addOrRequestDrop).toHaveBeenCalled()
        await act(async () => { probe.renderer.unmount() })
    })
})
