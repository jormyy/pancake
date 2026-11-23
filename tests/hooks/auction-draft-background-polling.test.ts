import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

const mocks = vi.hoisted(() => ({
    visibility: 'visible',
    getDraftState: vi.fn(async () => null),
    revision: vi.fn<(...args: string[]) => Promise<string | null>>(async () => 'revision-1'),
    version: null as null | ((snapshot: { changes: { topic: string }[] }) => void),
    status: null as ((status: string) => void) | null,
}))
vi.mock('@/lib/cache/screen-cache', () => ({ readScreenView: () => mocks.getDraftState() }))
vi.mock('@/lib/league-version', () => ({ subscribeLeagueVersion: (_league: string, listener: typeof mocks.version) => { mocks.version = listener; return () => { mocks.version = null } } }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({ currentLeague: { id: 'league' } }) }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
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
setSessionOwner('draft-test-user')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
const Probe = ({ draftId = 'draft-1' }: { draftId?: string }) => {
    useAuctionDraftRoomController({ draftId, memberId: 'member-1' })
    return null
}
const mount = async () => { await act(async () => { renderer = create(React.createElement(Probe)) }) }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
let page: EventTarget
const transition = async (next: 'active' | 'background') => {
    await act(async () => {
        mocks.visibility = next === 'active' ? 'visible' : 'hidden'
        page.dispatchEvent(new Event('visibilitychange'))
    })
}
beforeEach(() => {
    vi.useFakeTimers()
    mocks.visibility = 'visible'
    page = Object.defineProperty(new EventTarget(), 'visibilityState', { get: () => mocks.visibility })
    vi.stubGlobal('document', page)
    mocks.revision.mockReset().mockResolvedValue('revision-1')
    mocks.getDraftState.mockClear()
})
afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
})
const changed = async () => { await act(async () => mocks.version?.({ changes: [{ topic: 'draft' }] })) }

it('loads a missing room once without polling its absence', async () => {
    await mount()
    await advance(60_000)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    expect(mocks.revision).not.toHaveBeenCalled()
})

it('refreshes a visible room after a draft version changes', async () => {
    await mount()
    await changed()
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
})

it('keeps hidden reads stopped and catches up on return', async () => {
    await mount()
    await transition('background')
    await changed()
    await advance(60_000)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    await transition('active')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
})

it('retains one catch-up after another background transition', async () => {
    await mount()
    await transition('background')
    await changed()
    await changed()
    await transition('active')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
    await transition('background')
    await transition('active')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(3)
})

it('removes its version observer and lifecycle listeners on teardown', async () => {
    await mount()
    await act(async () => renderer!.unmount())
    renderer = undefined
    expect(mocks.version).toBeNull()
    const reads = mocks.getDraftState.mock.calls.length
    await transition('background')
    await transition('active')
    await advance(60_000)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(reads)
})
