import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuickAdd } from '@/hooks/use-quick-add'
import type { RosterPlayer } from '@/lib/roster'

const mocks = vi.hoisted(() => ({ gate: vi.fn(), add: vi.fn(), alert: vi.fn(), success: vi.fn(), dropAndAdd: vi.fn(), claim: vi.fn() }))
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
    latest = useQuickAdd({ memberId, leagueId: 'league', onChanged: changed, onClaimInstead: mocks.claim })
    return null
}
beforeEach(async () => {
    vi.resetAllMocks()
    mocks.gate.mockResolvedValue(clearGate)
    mocks.add.mockResolvedValue({ status: 'added' })
    await act(async () => { renderer = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => { renderer?.unmount(); renderer = null }) })

describe('claim pending admission', () => {
    it('admits one same-player claim while the roster gate is pending', async () => {
        const gate = deferred<typeof clearGate>()
        mocks.gate.mockReturnValue(gate.promise)
        const submit = latest.handleAdd
        let first!: Promise<void>
        await act(async () => { first = submit(player) })
        expect(latest.adding).toBe(player.id)
        await act(async () => { await submit(player) })
        expect(mocks.gate).toHaveBeenCalledOnce()
        expect(mocks.claim).not.toHaveBeenCalled()
        await act(async () => { gate.resolve(clearGate); await first })
        expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(player)
        expect(mocks.add).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
        expect(mocks.success).not.toHaveBeenCalled()
        expect(latest.adding).toBeNull()
    })

    it('allows a new attempt after the roster read fails', async () => {
        mocks.gate.mockRejectedValueOnce(new Error('Owned gate failure'))
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.claim).not.toHaveBeenCalled()
        expect(latest.adding).toBeNull()
        expect(mocks.alert).toHaveBeenCalledWith('Error', 'Owned gate failure')
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(player)
    })

    it('preserves a different player request when the first player finishes', async () => {
        const firstGate = deferred<typeof clearGate>()
        const secondGate = deferred<typeof clearGate>()
        mocks.gate.mockReturnValueOnce(firstGate.promise).mockReturnValueOnce(secondGate.promise)
        let first!: Promise<void>, second!: Promise<void>
        await act(async () => { first = latest.handleAdd(player) })
        await act(async () => { second = latest.handleAdd(other) })
        await act(async () => { firstGate.resolve(clearGate); await first })
        expect(latest.adding).toBe(other.id)
        await act(async () => { await latest.handleAdd(other) })
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(player)
        await act(async () => { secondGate.resolve(clearGate); await second })
        expect(mocks.claim).toHaveBeenNthCalledWith(2, other)
        expect(latest.adding).toBeNull()
    })

    it.each(['success', 'failure'] as const)('ignores a late gate %s after unmount', async outcome => {
        const gate = deferred<typeof clearGate>()
        mocks.gate.mockReturnValueOnce(gate.promise)
        let pending!: Promise<void>
        await act(async () => { pending = latest.handleAdd(player) })
        await act(async () => { renderer!.unmount(); renderer = null })
        await act(async () => {
            if (outcome === 'success') gate.resolve(clearGate)
            else gate.reject(new Error('Old gate failure'))
            await pending
        })
        expect(mocks.claim).not.toHaveBeenCalled()
        expect(mocks.alert).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
    })

    it('keeps a fresh owner request pending when an old owner gate settles', async () => {
        const oldGate = deferred<typeof clearGate>()
        const newGate = deferred<typeof clearGate>()
        mocks.gate.mockReturnValueOnce(oldGate.promise).mockReturnValueOnce(newGate.promise)
        let old!: Promise<void>, fresh!: Promise<void>
        await act(async () => { old = latest.handleAdd(player) })
        await act(async () => { renderer!.update(React.createElement(Probe, { memberId: 'different' })) })
        await act(async () => { renderer!.update(React.createElement(Probe)) })
        await act(async () => { fresh = latest.handleAdd(player) })
        await act(async () => { oldGate.resolve(clearGate); await old })
        expect(latest.adding).toBe(player.id)
        expect(mocks.claim).not.toHaveBeenCalled()
        await act(async () => { await latest.handleAdd(player) })
        expect(mocks.gate).toHaveBeenCalledTimes(2)
        await act(async () => { newGate.resolve(clearGate); await fresh })
        expect(latest.adding).toBeNull()
        expect(mocks.claim).toHaveBeenCalledExactlyOnceWith(player)
    })
})
