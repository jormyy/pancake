import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import type { MemberTransactionState } from '@/lib/league'
import { RequestError } from '@/lib/shared/errors'
import { memberTransactionState, playerRow, rosterPlayer } from '../helpers/fixtures'

const mocks = vi.hoisted(() => ({
    alert: vi.fn(),
    success: vi.fn(),
    confirm: vi.fn(),
    loadGate: vi.fn(),
    addOrRequestDrop: vi.fn(),
    dropAndAdd: vi.fn(),
}))

vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: mocks.confirm }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: mocks.dropAndAdd }))
vi.mock('@/lib/roster-add-flow', () => ({
    addFreeAgentOrRequestDrop: mocks.addOrRequestDrop,
    loadRosterAddGate: mocks.loadGate,
    resolveRosterAddIRConflict: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const player = playerRow()
const ownRosterPlayer = rosterPlayer()
const futureReset = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
const pastReset = new Date(Date.now() - 60 * 1000).toISOString()
const LIMIT_MESSAGE = 'Weekly add limit reached (3/3 adds used this week). Adds reset Mon, Nov 2 at 12:00 AM ET.'

const usedUp = (overrides: Partial<MemberTransactionState> = {}) =>
    memberTransactionState({
        weeklyAddLimit: 3, weeklyAddCount: 3, addLimitResetsAt: futureReset,
        addLimitMessage: LIMIT_MESSAGE, addLimitResetsLabel: 'Mon, Nov 2 at 12:00 AM ET', ...overrides,
    })

type Latest = ReturnType<typeof useQuickAdd>
let renderer: ReactTestRenderer | null = null

async function mount(transactionState: MemberTransactionState | null, options: Partial<Parameters<typeof useQuickAdd>[0]> = {}) {
    const onChanged = vi.fn()
    let latest!: Latest
    const Probe = () => {
        latest = useQuickAdd({ memberId: 'member-a', leagueId: 'league-a', onChanged, transactionState, ...options })
        return null
    }
    await act(async () => { renderer = create(React.createElement(Probe)) })
    return { get latest() { return latest }, onChanged }
}

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset()
})

afterEach(async () => {
    if (renderer) await act(async () => { renderer?.unmount() })
    renderer = null
})

describe('useQuickAdd weekly add limit', () => {
    it('explains a used-up week before calling the server and exposes the reason for rendering', async () => {
        const probe = await mount(usedUp())
        expect(probe.latest.addBlockedReason).toBe(LIMIT_MESSAGE)
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.loadGate).not.toHaveBeenCalled()
        expect(mocks.addOrRequestDrop).not.toHaveBeenCalled()
        expect(mocks.alert).toHaveBeenCalledTimes(1)
        expect(mocks.alert.mock.calls[0][0]).toBe('Weekly add limit reached')
        expect(mocks.alert.mock.calls[0][1]).toBe(probe.latest.addBlockedReason)
        expect(probe.onChanged).toHaveBeenCalled()
    })

    it('proceeds once the reported week has ended, even if the cached count is full', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'added' })
        const probe = await mount(usedUp({ addLimitResetsAt: pastReset }))
        expect(probe.latest.addBlockedReason).toBeNull()
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.addOrRequestDrop).toHaveBeenCalledWith('member-a', 'league-a', 'player-a', [])
        expect(mocks.success).toHaveBeenCalledWith('Added', 'Player A added to your roster.')
    })

    it('shows the server reset message and closes the drop picker when the last slot went elsewhere', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [ownRosterPlayer], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'roster_full', activeRoster: [ownRosterPlayer] })
        const probe = await mount(usedUp({ weeklyAddCount: 2, addLimitMessage: null }))
        await act(async () => { await probe.latest.handleAdd(player) })
        expect(probe.latest.dropPickerPlayer).toEqual(player)

        mocks.dropAndAdd.mockRejectedValue(new RequestError(LIMIT_MESSAGE, { code: 'PA001' }))
        await act(async () => { await probe.latest.handleDropAndAdd(ownRosterPlayer) })

        expect(mocks.alert).toHaveBeenLastCalledWith('Weekly add limit reached', LIMIT_MESSAGE)
        expect(probe.latest.dropPickerPlayer).toBeNull()
        expect(probe.onChanged).toHaveBeenCalled()
    })

    it('offers the claim flow when the server still holds the player on waivers', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockRejectedValue(new RequestError('This player is on waivers - submit a waiver claim instead.', { code: 'PA002' }))
        const onClaimInstead = vi.fn()
        const probe = await mount(usedUp({ weeklyAddCount: 1, addLimitMessage: null }), { onClaimInstead })
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.alert).not.toHaveBeenCalled()
        const [title, message, claim, confirmText, destructive] = mocks.confirm.mock.calls[0]
        expect({ title, message, confirmText, destructive }).toEqual({
            title: 'Still on waivers',
            message: 'This player is on waivers - submit a waiver claim instead. Claims are processed on the next waiver run.',
            confirmText: 'Claim',
            destructive: false,
        })
        claim()
        expect(onClaimInstead).toHaveBeenCalledWith(player)
    })

    it('keeps other server errors on the generic path', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockRejectedValue(new RequestError('Your active roster is full (20 players).', { code: 'P0001' }))
        const probe = await mount(usedUp({ weeklyAddCount: 1, addLimitMessage: null }))
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.alert).toHaveBeenCalledWith('Error', 'Your active roster is full (20 players).')
    })

    it('runs the IR gate before a claim and hands off once IR is clear', async () => {
        const onClaimInstead = vi.fn()
        mocks.loadGate.mockResolvedValue({ roster: [ownRosterPlayer], ineligible: [ownRosterPlayer] })
        const probe = await mount(memberTransactionState(), { onClaimInstead })
        await act(async () => { await probe.latest.handleClaim(player) })
        expect(probe.latest.irModal).toMatchObject({ action: 'claim', pendingPlayer: player })
        expect(onClaimInstead).not.toHaveBeenCalled()

        mocks.loadGate.mockResolvedValue({ roster: [ownRosterPlayer], ineligible: [] })
        await act(async () => { probe.latest.setIrModal(null); await probe.latest.handleClaim(player) })
        expect(onClaimInstead).toHaveBeenCalledWith(player)
    })

    it('does nothing special for unlimited leagues', async () => {
        mocks.loadGate.mockResolvedValue({ roster: [], ineligible: [] })
        mocks.addOrRequestDrop.mockResolvedValue({ status: 'added' })
        const probe = await mount(memberTransactionState({ weeklyAddLimit: null, weeklyAddCount: 40 }))
        expect(probe.latest.addBlockedReason).toBeNull()
        await act(async () => { await probe.latest.handleAdd(player) })

        expect(mocks.addOrRequestDrop).toHaveBeenCalled()
    })
})
