import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLeagues } from '@/hooks/use-leagues'
import { writePersistentCache } from '@/lib/persistent-cache'

const mocks = vi.hoisted(() => ({
    userId: null as string | null,
    online: true,
    fetch: vi.fn(),
    cached: [] as { id: string; leagues: { id: string } }[],
}))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }) }))
vi.mock('@/hooks/use-online-status', () => ({ useOnlineStatus: () => mocks.online }))
vi.mock('@/lib/league', () => ({ fetchUserLeagues: mocks.fetch }))
vi.mock('@/lib/persistent-cache', () => ({
    readPersistentCache: () => mocks.cached,
    writePersistentCache: vi.fn(),
    removePersistentCache: vi.fn(),
}))
vi.mock('@/lib/realtime', () => ({
    subscribeToTableChanges: vi.fn(() => ({})),
    unsubscribeFromTableChanges: vi.fn(),
    reportRealtimeCleanup: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer | null
let latest: ReturnType<typeof useLeagues>
const rows = [{ id: 'member', leagues: { id: 'league' } }]
const Probe = () => { latest = useLeagues(); return null }
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const mount = async () => { await act(async () => { screen = create(React.createElement(Probe)) }) }
const render = async () => { await act(async () => { screen!.update(React.createElement(Probe)) }) }

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.userId = 'user'
    mocks.online = true
    mocks.cached = []
    mocks.fetch.mockReset().mockRejectedValueOnce(new Error('Temporary read failure')).mockResolvedValue(rows)
    screen = null
})
afterEach(async () => {
    await act(async () => { screen?.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

it('retries a failed first membership read after sign-in once with backoff', async () => {
    mocks.userId = null
    await mount()
    expect(mocks.fetch).not.toHaveBeenCalled()
    mocks.userId = 'user'
    await render()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(latest.membershipValidated).toBe(false)
    expect(writePersistentCache).not.toHaveBeenCalled()

    await advance(999)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(latest.membershipStatus).toBe('available')
    expect(latest.membershipValidated).toBe(true)
    expect(latest.error).toBeNull()
    expect(latest.memberships).toEqual(rows)
    expect(writePersistentCache).toHaveBeenCalledWith('pancake:league-memberships:v1:user', rows)
    await advance(10_000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it('stops after one failed retry and still allows an explicit refresh', async () => {
    mocks.fetch.mockReset().mockRejectedValue(new Error('Still unavailable'))
    await mount()
    await advance(1000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    await advance(10_000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(latest.membershipStatus).toBe('unavailable')
    expect(latest.membershipValidated).toBe(false)
    expect(writePersistentCache).not.toHaveBeenCalled()
    mocks.fetch.mockResolvedValue(rows)
    await act(async () => { await latest.refresh() })
    expect(latest.memberships).toEqual(rows)
    expect(latest.error).toBeNull()
})

it('keeps cached memberships visible until the delayed retry validates them', async () => {
    mocks.cached = rows
    await mount()
    expect(latest.memberships).toEqual(rows)
    expect(latest.membershipStatus).toBe('available')
    expect(latest.membershipValidated).toBe(false)
    await advance(1000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(latest.memberships).toEqual(rows)
    expect(latest.membershipValidated).toBe(true)
})

it.each(['sign-out', 'account switch', 'unmount'])('cancels a pending retry after %s', async change => {
    await mount()
    if (change === 'unmount') {
        await act(async () => { screen!.unmount(); screen = null })
    } else {
        mocks.userId = change === 'sign-out' ? null : 'other'
        await render()
    }
    await advance(10_000)
    expect(mocks.fetch.mock.calls.map(([userId]) => userId)).toEqual(change === 'account switch' ? ['user', 'other'] : ['user'])
    if (change === 'sign-out') expect(latest.membershipStatus).toBe('signed-out')
})

it.each(['hidden', 'offline'])('defers the delayed retry while %s and recovers on return', async condition => {
    const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const browser = new EventTarget()
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', browser)
    await mount()
    if (condition === 'hidden') page.visibilityState = 'hidden'
    else { mocks.online = false; await render() }
    await advance(1000)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    page.visibilityState = 'visible'
    mocks.online = true
    await render()
    await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
    await advance(1000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(latest.membershipStatus).toBe('available')
})
