import React from 'react'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'
import type { DraftState } from '@/lib/draft'
import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'
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



const notify = async () => {
    await act(async () => { mocks.channels.at(-1)!.on.mock.calls[0][2]() })
}

it('admits a sustained bid stream within 500 ms', async () => {
    await mount()
    await status('SUBSCRIBED')
    mocks.getDraftState.mockClear()
    for (let index = 0; index < 5; index++) {
        await notify()
        await advance(100)
    }
    expect(mocks.getDraftState.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(mocks.getDraftState.mock.calls.length).toBeLessThanOrEqual(2)
})

it('renders a slow read while new bid events queue one follow-up', async () => {
    await mount()
    await status('SUBSCRIBED')
    let finish!: (value: DraftState) => void
    mocks.getDraftState.mockClear().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await notify()
    await advance(250)
    for (let index = 0; index < 3; index++) { await notify(); await advance(300) }
    expect(mocks.getDraftState).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ ...draftState(), draft: { ...draftState().draft, currentNominationOrder: 10 } }) })
    expect(latest.state?.draft.currentNominationOrder).toBe(10)
    await advance(250)
    expect(mocks.getDraftState).toHaveBeenCalledTimes(2)
})

it('holds updates throughout a mounted auction and releases on teardown', async () => {
    vi.stubGlobal('window', new EventTarget())
    await mount()
    expect(isPwaUpdateHeld()).toBe(true)
    await status('CHANNEL_ERROR')
    expect(isPwaUpdateHeld()).toBe(true)
    act(() => renderer!.unmount())
    renderer = undefined
    expect(isPwaUpdateHeld()).toBe(false)
})

it('cancels queued bid reads on teardown', async () => {
    await mount()
    mocks.getDraftState.mockClear()
    await notify()
    act(() => renderer!.unmount())
    renderer = undefined
    await advance(1000)
    expect(mocks.getDraftState).not.toHaveBeenCalled()
})
