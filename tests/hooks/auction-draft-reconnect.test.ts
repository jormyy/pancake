import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'
import type { RealtimeSubscriptionStatus } from '@/lib/realtime'
vi.mock('@/lib/persistent-cache', () => ({ readPersistentCache: () => null, writePersistentCache: vi.fn() }))

const mocks = vi.hoisted(() => ({
    getDraftState: vi.fn<() => Promise<DraftState | null>>(),
    revision: vi.fn(async () => 'revision-1'),
    callbacks: [] as ((status: RealtimeSubscriptionStatus) => void)[],
    channels: [] as { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }[],
    remove: vi.fn(async () => undefined),
}))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
vi.mock('react-native', () => ({
    AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
}))
vi.mock('@/lib/supabase', () => ({ supabase: {
    channel: () => {
        const channel = {
            on: vi.fn(() => channel),
            subscribe: vi.fn((callback: (status: RealtimeSubscriptionStatus) => void) => {
                mocks.callbacks.push(callback)
                return channel
            }),
        }
        mocks.channels.push(channel)
        return channel
    },
    removeChannel: mocks.remove,
} }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))
vi.mock('@/lib/draft', async (original) => ({
    ...await original<typeof import('@/lib/draft')>(),
    getDraftState: mocks.getDraftState,
    getDraftPollRevision: mocks.revision,
}))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
setSessionOwner('draft-test-user')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
let latest!: ReturnType<typeof useAuctionDraftRoomController>
const Probe = ({ draftId = 'draft-1' }: { draftId?: string }) => {
    latest = useAuctionDraftRoomController({ draftId, memberId: 'member-1' })
    return null
}
const mount = async () => { await act(async () => { renderer = create(React.createElement(Probe)) }) }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const status = async (next: RealtimeSubscriptionStatus) => {
    await act(async () => { mocks.callbacks.at(-1)?.(next) })
}
beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.callbacks.length = 0
    mocks.channels.length = 0
    mocks.getDraftState.mockReset().mockResolvedValue(draftState())
    mocks.revision.mockReset().mockResolvedValue('revision-1')
})
afterEach(() => {
    act(() => renderer?.unmount())
    renderer = undefined
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

function draftState(): DraftState {
    return {
        draft: {
            id: 'draft-1',
            leagueId: 'league-1',
            status: 'paused',
            draftType: 'auction',
            isMock: false,
            currentNominationOrder: 0,
            nominationOrderMode: 'user_nominated',
            budgetPerTeam: 200,
            scheduledAt: null,
            roomName: null,
            createdByMemberId: null,
            pickTimerSeconds: 30,
            timerExpiryBehavior: 'auction_no_bid',
            rounds: null,
            startedAt: null,
            pauseReason: 'member_absent',
            pausedAt: null,
            pausedRemainingSeconds: 10,
        },
        order: [{ position: 1, memberId: 'member-1', teamName: 'Team' }],
        budgets: [],
        nominations: [],
        activeBids: [],
        openNomination: null,
        currentNominatorMemberId: 'member-1',
    }
}


it('catches up after a reachable error and socket rejoin', async () => {
    await mount()
    await status('SUBSCRIBED')
    expect(latest.state?.draft.currentNominationOrder).toBe(0)
    const initialReads = mocks.getDraftState.mock.calls.length
    mocks.getDraftState.mockResolvedValue({ ...draftState(), draft: { ...draftState().draft, currentNominationOrder: 1 } })
    await status('CHANNEL_ERROR')
    await advance(1_000)
    await status('SUBSCRIBED')
    expect(latest.state?.draft.currentNominationOrder).toBe(1)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(initialReads + 1)
    await status('SUBSCRIBED')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(initialReads + 1)
    expect(mocks.revision).not.toHaveBeenCalled()
})

it('opens one subscription and one initial read while resolving the league', async () => {
    await mount()
    await status('SUBSCRIBED')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    expect(mocks.channels).toHaveLength(1)
})

it('rebuilds a terminally closed channel and loads the room once', async () => {
    await mount()
    await status('SUBSCRIBED')
    mocks.getDraftState.mockResolvedValue({ ...draftState(), draft: { ...draftState().draft, currentNominationOrder: 4 } })
    await status('CLOSED')
    await advance(3_000)
    await status('SUBSCRIBED')
    expect(latest.state?.draft.currentNominationOrder).toBe(4)
    expect(mocks.channels).toHaveLength(2)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
})

it('retries a failed recovery while retaining usable state', async () => {
    await mount()
    await status('SUBSCRIBED')
    mocks.getDraftState.mockRejectedValueOnce(new Error('Read unavailable'))
    await status('TIMED_OUT')
    await status('SUBSCRIBED')
    expect(latest.state?.draft.currentNominationOrder).toBe(0)
    expect(latest.loadError).toBe('Read unavailable')
    mocks.getDraftState.mockResolvedValue({ ...draftState(), draft: { ...draftState().draft, currentNominationOrder: 2 } })
    await advance(2_000)
    expect(latest.state?.draft.currentNominationOrder).toBe(2)
    expect(latest.loadError).toBeNull()
    expect(mocks.getDraftState).toHaveBeenCalledTimes(3)
})

it('retains hidden and offline catch-up until the page is usable', async () => {
    const documentEvents = new EventTarget()
    let visibilityState = 'visible'
    Object.defineProperty(documentEvents, 'visibilityState', { get: () => visibilityState })
    const browserEvents = new EventTarget()
    const network = { onLine: true }
    vi.stubGlobal('document', documentEvents)
    vi.stubGlobal('window', browserEvents)
    vi.stubGlobal('navigator', network)
    await mount()
    await status('SUBSCRIBED')
    visibilityState = 'hidden'
    network.onLine = false
    await status('CHANNEL_ERROR')
    await status('SUBSCRIBED')
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    visibilityState = 'visible'
    await act(async () => { documentEvents.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    mocks.getDraftState.mockResolvedValue({ ...draftState(), draft: { ...draftState().draft, currentNominationOrder: 3 } })
    network.onLine = true
    await act(async () => { browserEvents.dispatchEvent(new Event('online')) })
    expect(latest.state?.draft.currentNominationOrder).toBe(3)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
    await act(async () => { browserEvents.dispatchEvent(new Event('online')); documentEvents.dispatchEvent(new Event('visibilitychange')) })
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
})

it('disposes recovery after an owner change, including late status and read callbacks', async () => {
    await mount()
    await status('SUBSCRIBED')
    const oldStatus = mocks.callbacks.at(-1)!
    let resolve!: (state: DraftState) => void
    mocks.getDraftState.mockReturnValueOnce(new Promise(done => { resolve = done }))
    await status('CHANNEL_ERROR')
    await status('SUBSCRIBED')
    mocks.getDraftState.mockResolvedValue({ ...draftState(), draft: { ...draftState().draft, id: 'draft-2', currentNominationOrder: 5 } })
    await act(async () => { renderer?.update(React.createElement(Probe, { draftId: 'draft-2' })) })
    expect(latest.state?.draft.id).toBe('draft-2')
    const reads = mocks.getDraftState.mock.calls.length
    await act(async () => { oldStatus('CHANNEL_ERROR'); oldStatus('SUBSCRIBED'); resolve(draftState()) })
    await advance(4_000)
    expect(latest.state?.draft.currentNominationOrder).toBe(5)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(reads)
    expect(mocks.remove).toHaveBeenCalledWith(mocks.channels[0])
})
