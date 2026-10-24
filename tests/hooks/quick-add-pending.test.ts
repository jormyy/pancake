import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import { rosterPlayer as makeRosterPlayer } from '../helpers/fixtures'
import type { RosterPlayer } from '@/lib/roster'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), add: vi.fn(), alert: vi.fn(), success: vi.fn(), dropAndAdd: vi.fn() }))
vi.mock('@/lib/roster', () => ({ dropAndAddFreeAgent: mocks.dropAndAdd }))
vi.mock('@/lib/roster-add-flow', () => ({
    loadRosterAddGate: mocks.gate, addFreeAgentOrRequestDrop: mocks.add, resolveRosterAddIRConflict: vi.fn(),
}))
vi.mock('@/lib/alert', () => ({ showAlert: mocks.alert, showSuccess: mocks.success, confirmAction: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const player = { id: 'player-a', display_name: 'Player A' }
const other = { id: 'player-b', display_name: 'Player B' }
const clearGate = { roster: [] as RosterPlayer[], ineligible: [] as RosterPlayer[] }
const deferred = <T,>() => {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    return { promise, resolve, reject }
}
let renderer: ReactTestRenderer | null
let latest: ReturnType<typeof useQuickAdd>
const changed = vi.fn()
const Probe = ({ memberId = 'member' }: { memberId?: string }) => {
    latest = useQuickAdd({ memberId, leagueId: 'league', onChanged: changed })
    return null
}
beforeEach(async () => {
    vi.resetAllMocks()
    mocks.gate.mockResolvedValue(clearGate)
    mocks.add.mockResolvedValue({ status: 'added' })
    await act(async () => { renderer = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => { renderer?.unmount(); renderer = null }) })

describe('pickup pending admission', () => {
    it.each(['gate', 'write'] as const)('admits only one same-player pickup while %s is pending', async (phase) => {
        const gate = deferred<typeof clearGate>()
        const write = deferred<{ status: 'added' }>()
        mocks.gate.mockReturnValue(gate.promise)
        mocks.add.mockReturnValue(write.promise)
        const retained = latest.handleAdd
        let first!: Promise<void>, second!: Promise<void>
        await act(async () => { first = retained(player) })
        const pendingIndicator = latest.adding
        if (phase === 'write') await act(async () => { gate.resolve(clearGate) })
        await act(async () => { second = retained(player) })
        await act(async () => { gate.resolve(clearGate); write.resolve({ status: 'added' }); await Promise.all([first, second]) })
        expect(pendingIndicator).toBe(player.id)
        expect(mocks.gate).toHaveBeenCalledOnce()
        expect(mocks.add).toHaveBeenCalledOnce()
        expect(changed).toHaveBeenCalledOnce()
        expect(mocks.success).toHaveBeenCalledOnce()
        expect(latest.adding).toBeNull()
    })

    it('allows a new attempt after the initial roster read fails', async () => {
        mocks.gate.mockRejectedValueOnce(new Error('Owned gate failure'))
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.add).not.toHaveBeenCalled()
        expect(latest.adding).toBeNull()
        expect(mocks.alert).toHaveBeenCalledWith('Error', 'Owned gate failure')
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        expect(mocks.add).toHaveBeenCalledOnce()
        expect(changed).toHaveBeenCalledOnce()
    })

    it('preserves a different player request when the first player finishes', async () => {
        const firstWrite = deferred<{ status: 'added' }>()
        const secondWrite = deferred<{ status: 'added' }>()
        mocks.add.mockImplementation((_member, _league, id) => id === player.id ? firstWrite.promise : secondWrite.promise)
        let first!: Promise<void>, second!: Promise<void>, duplicate!: Promise<void>
        await act(async () => { first = latest.handleAdd(player) })
        await act(async () => { second = latest.handleAdd(other) })
        expect(mocks.add).toHaveBeenCalledTimes(2)
        await act(async () => { firstWrite.resolve({ status: 'added' }); await first })
        const secondStillPending = latest.adding
        await act(async () => { duplicate = latest.handleAdd(other) })
        await act(async () => { secondWrite.resolve({ status: 'added' }); await Promise.all([second, duplicate]) })
        expect(secondStillPending).toBe(other.id)
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        expect(mocks.add).toHaveBeenCalledTimes(2)
    })

    it('refreshes ownership after a conflicting acquisition while preserving the error', async () => {
        mocks.add.mockRejectedValue({ code: '23505', message: 'This player is already on a roster' })
        await act(async () => { await latest.handleAdd(player) })
        expect(changed).toHaveBeenCalledOnce()
        expect(mocks.alert).toHaveBeenCalledWith('Error', 'This player is already on a roster')
        expect(mocks.success).not.toHaveBeenCalled()
    })

    it.each(['gate', 'write'] as const)('ignores a %s completion after its screen unmounts', async (phase) => {
        const gate = deferred<typeof clearGate>()
        const write = deferred<{ status: 'added' }>()
        mocks.gate.mockReturnValue(gate.promise)
        mocks.add.mockReturnValue(write.promise)
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleAdd(player) })
        if (phase === 'write') await act(async () => { gate.resolve(clearGate) })
        await act(async () => { renderer!.unmount(); renderer = null })
        await act(async () => { gate.resolve(clearGate); write.resolve({ status: 'added' }); await pending })
        expect(mocks.add).toHaveBeenCalledTimes(phase === 'write' ? 1 : 0)
        expect(changed).not.toHaveBeenCalled()
        expect(mocks.alert).not.toHaveBeenCalled()
        expect(mocks.success).not.toHaveBeenCalled()
    })

    it('releases admission after a rejected write so retry can succeed', async () => {
        mocks.add.mockRejectedValueOnce(new Error('Owned write failure'))
        await act(async () => { await latest.handleAdd(player) })
        expect(latest.adding).toBeNull()
        expect(changed).not.toHaveBeenCalled()
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.add).toHaveBeenCalledTimes(2)
        expect(changed).toHaveBeenCalledOnce()
        expect(mocks.success).toHaveBeenCalledOnce()
    })

    it.each(['gate', 'write'] as const)('does not release a new owner lifetime when the old %s settles', async (phase) => {
        const oldGate = deferred<typeof clearGate>()
        const oldWrite = deferred<{ status: 'added' }>()
        const newWrite = deferred<{ status: 'added' }>()
        mocks.gate.mockReturnValueOnce(oldGate.promise)
        if (phase === 'write') mocks.add.mockReturnValueOnce(oldWrite.promise)
        mocks.add.mockReturnValue(newWrite.promise)
        let old!: Promise<void>, fresh!: Promise<void>
        await act(async () => { old = latest.handleAdd(player) })
        if (phase === 'write') await act(async () => { oldGate.resolve(clearGate) })
        await act(async () => { renderer!.update(React.createElement(Probe, { memberId: 'different' })) })
        await act(async () => { renderer!.update(React.createElement(Probe)) })
        await act(async () => { fresh = latest.handleAdd(player) })
        await act(async () => { oldGate.resolve(clearGate); oldWrite.resolve({ status: 'added' }); await old })
        expect(latest.adding).toBe(player.id)
        expect(changed).not.toHaveBeenCalled()
        expect(mocks.success).not.toHaveBeenCalled()
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        expect(mocks.add).toHaveBeenCalledTimes(phase === 'write' ? 2 : 1)
        await act(async () => { newWrite.resolve({ status: 'added' }); await fresh })
        expect(latest.adding).toBeNull()
        expect(changed).toHaveBeenCalledOnce()
        expect(mocks.success).toHaveBeenCalledOnce()
    })

})

it.each(['gate', 'write'] as const)('admits one drop-and-add while its %s is pending', async (phase) => {
    const rosterPlayer = makeRosterPlayer()
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [rosterPlayer] })
    await act(async () => { await latest.handleAdd(player) })
    const gate = deferred<typeof clearGate>()
    const write = deferred<void>()
    mocks.gate.mockReturnValue(gate.promise)
    mocks.dropAndAdd.mockReturnValue(write.promise)
    const submit = latest.handleDropAndAdd
    let first!: Promise<void>, second!: Promise<void>
    await act(async () => { first = submit(rosterPlayer) })
    const pendingIndicator = latest.dropping
    if (phase === 'write') await act(async () => { gate.resolve(clearGate) })
    await act(async () => { second = submit(rosterPlayer) })
    await act(async () => { gate.resolve(clearGate); write.resolve(); await Promise.all([first, second]) })
    expect(pendingIndicator).toBe(rosterPlayer.id)
    expect(mocks.gate).toHaveBeenCalledTimes(2)
    expect(mocks.dropAndAdd).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
    expect(latest.dropPickerPlayer).toBeNull()
    expect(latest.dropping).toBeNull()
})

it.each(['gate', 'write'] as const)('allows drop-and-add retry after %s failure', async (phase) => {
    const rosterPlayer = makeRosterPlayer()
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [rosterPlayer] })
    await act(async () => { await latest.handleAdd(player) })
    if (phase === 'gate') mocks.gate.mockRejectedValueOnce(new Error('Gate failed'))
    else mocks.dropAndAdd.mockRejectedValueOnce(new Error('Write failed'))
    await act(async () => { await latest.handleDropAndAdd(rosterPlayer) })
    expect(latest.dropping).toBeNull()
    expect(latest.dropPickerPlayer).toEqual(player)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => { await latest.handleDropAndAdd(rosterPlayer) })
    expect(mocks.dropAndAdd).toHaveBeenCalledTimes(phase === 'gate' ? 1 : 2)
    expect(changed).toHaveBeenCalledOnce()
})

it('keeps a late drop gate from writing into another owner lifetime', async () => {
    const rosterPlayer = makeRosterPlayer()
    mocks.add.mockResolvedValueOnce({ status: 'roster_full', activeRoster: [rosterPlayer] })
    await act(async () => { await latest.handleAdd(player) })
    const gate = deferred<typeof clearGate>()
    mocks.gate.mockReturnValueOnce(gate.promise)
    let pending!: Promise<void>
    const submit = latest.handleDropAndAdd
    await act(async () => { pending = submit(rosterPlayer) })
    await act(async () => { renderer!.update(React.createElement(Probe, { memberId: 'different' })) })
    await act(async () => { gate.resolve(clearGate); await pending; await submit(rosterPlayer) })
    expect(mocks.dropAndAdd).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(latest.dropping).toBeNull()
    expect(latest.dropPickerPlayer).toBeNull()
})
