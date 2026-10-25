import React, { useLayoutEffect } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { clearPersistentCaches, readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { setSessionOwner } from '@/lib/session-cache-registry'
import * as sessionRegistry from '@/lib/session-cache-registry'
import { subscribeToTableChanges } from '@/lib/realtime'

const { getPendingIncomingTradeCount, league } = vi.hoisted(() => ({
    getPendingIncomingTradeCount: vi.fn(),
    league: { value: { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } } },
}))

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('expo-router', () => ({ usePathname: () => '/' }))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => league.value }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: sessionRegistry.sessionOwner() ?? 'user-a' } }) }))
vi.mock('@/lib/trades', () => ({ getPendingIncomingTradeCount }))
vi.mock('@/lib/realtime', () => ({
    reportRealtimeCleanup: vi.fn(),
    subscribeToTableChanges: vi.fn(() => ({})),
    unsubscribeFromTableChanges: vi.fn(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const COUNTS: Record<string, number> = { 'league-a': 3, 'league-b': 5 }

beforeEach(() => {
    setSessionOwner('user-a')
    clearPersistentCaches()
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    league.value = { current: { id: 'member-a' }, currentLeague: { id: 'league-a' } }
    getPendingIncomingTradeCount.mockImplementation(async (_member: string, leagueId: string) => COUNTS[leagueId])
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('usePendingTradeCount', () => {
    it('refreshes a stale count on focus and retries without clearing its last count', async () => {
        const browser = new EventTarget()
        vi.stubGlobal('window', browser)
        let count = -1
        const Probe = () => { count = usePendingTradeCount(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        getPendingIncomingTradeCount.mockRejectedValueOnce(new Error('503')).mockResolvedValue(8)
        await act(async () => { await vi.advanceTimersByTimeAsync(300_000); browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(250) })
        expect(count).toBe(3)
        await act(async () => { browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(250) })
        expect(count).toBe(8)
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })

    it('reuses a fresh count on focus, defers hidden changes and forces online recovery', async () => {
        const browser = new EventTarget(), page = new EventTarget(), network = { onLine: true }
        let hidden = false
        Object.defineProperty(page, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' })
        vi.stubGlobal('window', browser); vi.stubGlobal('document', page); vi.stubGlobal('navigator', network)
        let count = -1
        const Probe = () => { count = usePendingTradeCount(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        for (let cycle = 0; cycle < 3; cycle++) {
            await act(async () => { browser.dispatchEvent(new Event('focus')) })
            hidden = true; await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
            hidden = false; await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
        }
        await act(async () => { await vi.advanceTimersByTimeAsync(250) })
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(1)
        hidden = true
        getPendingIncomingTradeCount.mockResolvedValue(6)
        const subscription = vi.mocked(subscribeToTableChanges).mock.calls.at(-1)![1]
        if (subscription.mode !== 'fallback') throw new Error('Badge must use its fallback refresh')
        await act(async () => { subscription.onChange(); await vi.advanceTimersByTimeAsync(5_000) })
        expect(count).toBe(3)
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(1)
        hidden = false
        await act(async () => { page.dispatchEvent(new Event('visibilitychange')) })
        expect(count).toBe(6)
        network.onLine = false
        getPendingIncomingTradeCount.mockResolvedValue(7)
        await act(async () => { subscription.onChange(); await vi.advanceTimersByTimeAsync(5_000) })
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(2)
        network.onLine = true
        await act(async () => { browser.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(250) })
        expect(count).toBe(7)
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(3)
        await act(async () => { renderer.unmount() })
    })

    it('reconciles a missed offer after rejoin', async () => {
        let count = -1
        const Probe = () => { count = usePendingTradeCount(); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(count).toBe(3)
        getPendingIncomingTradeCount.mockResolvedValue(7)
        const reconnect = vi.mocked(subscribeToTableChanges).mock.calls.at(-1)![1].onReconnect!
        await act(async () => { await reconnect() })
        expect(count).toBe(7)
        expect(getPendingIncomingTradeCount).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })

    it('shows only the current league count and retries a failed read', async () => {
        let latest = -1
        const Probe = ({ leagueId }: { leagueId: string }) => {
            league.value = { current: { id: `member-${leagueId}` }, currentLeague: { id: leagueId } }
            latest = usePendingTradeCount()
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { leagueId: 'league-a' })) })
        expect(latest).toBe(3)

        // The first read for the next league fails, like a dropped request.
        getPendingIncomingTradeCount.mockRejectedValueOnce(new Error('network'))
        await act(async () => { renderer.update(React.createElement(Probe, { leagueId: 'league-b' })) })
        expect(latest).toBe(0)

        await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
        expect(latest).toBe(5)
        await act(async () => { renderer.unmount() })
    })
})

it('renders a saved badge in its first frame while the count request is held', async () => {
    writePersistentCache('pancake:pending-trade-count:v1:user-a:league-a:member-a', 2)
    let release!: (count: number) => void
    getPendingIncomingTradeCount.mockReturnValueOnce(new Promise<number>(resolve => { release = resolve }))
    const frames: number[] = []
    const Probe = () => { frames.push(usePendingTradeCount()); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(frames[0]).toBe(2)
    expect(frames.every(count => count === 2)).toBe(true)
    await act(async () => { release(2) })
    expect(frames.every(count => count === 2)).toBe(true)
    expect(readPersistentCache('pancake:pending-trade-count:v1:user-a:league-a:member-a')).toBe(2)
    await act(async () => { renderer.unmount() })
})

it('saves a settled badge for a remount and rejects an older session response', async () => {
    let count = -1
    const Probe = () => { count = usePendingTradeCount(); return null }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(count).toBe(3)
    await act(async () => { renderer.unmount() })
    let release!: (count: number) => void
    getPendingIncomingTradeCount.mockReturnValueOnce(new Promise<number>(resolve => { release = resolve }))
    await act(async () => { renderer = create(React.createElement(Probe)) })
    expect(count).toBe(3)
    clearPersistentCaches()
    setSessionOwner(null)
    setSessionOwner('user-b')
    await act(async () => { release(9) })
    expect(readPersistentCache('pancake:pending-trade-count:v1:user-a:league-a:member-a')).toBeNull()
    await act(async () => { renderer.update(React.createElement(Probe)) })
    expect(count).not.toBe(9)
    await act(async () => { renderer.unmount() })
})

it('reads the authenticated owner cache before the parent publishes the cache session', async () => {
    writePersistentCache('pancake:pending-trade-count:v1:user-a:league-a:member-a', 2)
    const owner = vi.spyOn(sessionRegistry, 'sessionOwner').mockReturnValue(undefined)
    let release!: (count: number) => void
    getPendingIncomingTradeCount.mockReturnValueOnce(new Promise<number>(resolve => { release = resolve }))
    const frames: number[] = []
    const Probe = () => { frames.push(usePendingTradeCount()); return null }
    const Parent = () => {
        useLayoutEffect(() => { owner.mockRestore() }, [])
        return React.createElement(Probe)
    }
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(Parent)) })
    expect(frames[0]).toBe(2)
    await act(async () => { release(2) })
    expect(frames.every(count => count === 2)).toBe(true)
    await act(async () => { renderer.unmount() })
})
