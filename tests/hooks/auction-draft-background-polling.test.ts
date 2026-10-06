import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'

const mocks = vi.hoisted(() => ({
    appState: 'active',
    listeners: new Set<(state: string) => void>(),
    getDraftState: vi.fn(async () => null),
    revision: vi.fn<(...args: string[]) => Promise<string>>(async () => 'revision-1'),
    status: null as ((status: string) => void) | null,
}))
vi.mock('react-native', () => ({
    AppState: {
        get currentState() { return mocks.appState },
        addEventListener: (_event: string, listener: (state: string) => void) => {
            mocks.listeners.add(listener)
            return { remove: () => mocks.listeners.delete(listener) }
        },
    },
}))
vi.mock('@/lib/draft', () => ({
    getDraftState: mocks.getDraftState,
    getDraftPollRevision: mocks.revision,
    closeExpiredNominations: vi.fn(), nominatePlayer: vi.fn(), placeBid: vi.fn(),
    searchPlayers: vi.fn(async () => []), withdrawNomination: vi.fn(),
    subscribeToDraft: vi.fn((_id, _league, _change, status) => {
        mocks.status = status
        return { topic: 'draft' }
    }),
    unsubscribeFromDraft: vi.fn(async () => undefined),
}))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    debounceRealtimeRefresh: (change: () => void) => ({ trigger: change, cancel: vi.fn() }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
const Probe = ({ draftId = 'draft-1' }: { draftId?: string }) => {
    useAuctionDraftRoomController({ draftId, memberId: 'member-1' })
    return null
}
const mount = async () => { await act(async () => { renderer = create(React.createElement(Probe)) }) }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const transition = async (next: string) => {
    await act(async () => {
        mocks.appState = next
        for (const listener of mocks.listeners) listener(next)
    })
}
beforeEach(() => {
    vi.useFakeTimers()
    mocks.appState = 'active'
    mocks.listeners.clear()
    mocks.revision.mockReset().mockResolvedValue('revision-1')
    mocks.getDraftState.mockClear()
})
afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
})
describe('auction fallback polling across app visibility', () => {
    it('keeps visible fallback polling, stops hidden reads, and catches up on return', async () => {
        await mount()
        await advance(5_000)
        expect(mocks.revision).toHaveBeenCalledTimes(1)
        const initialLoads = mocks.getDraftState.mock.calls.length
        await transition('background')
        await advance(60_000)
        expect(mocks.revision).toHaveBeenCalledTimes(1)
        mocks.revision.mockResolvedValue('revision-2')
        await transition('active')
        expect(mocks.revision).toHaveBeenCalledTimes(2)
        expect(mocks.getDraftState).toHaveBeenCalledTimes(initialLoads + 1)
        await advance(5_000)
        expect(mocks.revision).toHaveBeenCalledTimes(3)
        expect(mocks.getDraftState).toHaveBeenCalledTimes(initialLoads + 1)
    })
    it('keeps the connected 60-second cadence and refreshes after an inactive return', async () => {
        await mount()
        await act(async () => { mocks.status?.('SUBSCRIBED') })
        await advance(59_999)
        expect(mocks.revision).not.toHaveBeenCalled()
        await advance(1)
        expect(mocks.revision).toHaveBeenCalledTimes(1)
        await transition('inactive')
        await advance(120_000)
        expect(mocks.revision).toHaveBeenCalledTimes(1)
        await transition('active')
        expect(mocks.revision).toHaveBeenCalledTimes(2)
    })
    it('does not poll when mounted in the background', async () => {
        mocks.appState = 'background'
        await mount()
        await advance(60_000)
        expect(mocks.revision).not.toHaveBeenCalled()
        await transition('active')
        expect(mocks.revision).toHaveBeenCalledTimes(1)
    })
    it('queues one catch-up when foreground returns during an old probe', async () => {
        let resolve!: (revision: string) => void
        mocks.revision.mockReturnValueOnce(new Promise<string>(done => { resolve = done }))
        await mount()
        await advance(5_000)
        await transition('background')
        await transition('active')
        await transition('active')
        mocks.revision.mockResolvedValue('revision-2')
        await act(async () => { resolve('revision-1') })
        expect(mocks.revision).toHaveBeenCalledTimes(2)
    })
    it('uses one catch-up after a queued resume returns to the background', async () => {
        let resolve!: (revision: string) => void
        mocks.revision.mockReturnValueOnce(new Promise<string>(done => { resolve = done }))
        await mount()
        await advance(5_000)
        await transition('background')
        await transition('active')
        await transition('background')
        await act(async () => { resolve('revision-1') })
        expect(mocks.revision).toHaveBeenCalledTimes(1)
        await transition('active')
        expect(mocks.revision).toHaveBeenCalledTimes(2)
    })
    it('discards a pending probe after the draft changes and removes listeners', async () => {
        let resolve!: (revision: string) => void
        mocks.revision.mockReturnValueOnce(new Promise<string>(done => { resolve = done }))
        await mount()
        await advance(5_000)
        await act(async () => { renderer?.update(React.createElement(Probe, { draftId: 'draft-2' })) })
        const loads = mocks.getDraftState.mock.calls.length
        await act(async () => { resolve('old-draft') })
        expect(mocks.getDraftState).toHaveBeenCalledTimes(loads)
        await advance(5_000)
        expect(mocks.revision).toHaveBeenLastCalledWith('draft-2')
        act(() => renderer?.unmount())
        renderer = undefined
        expect(mocks.listeners.size).toBe(0)
    })
})
