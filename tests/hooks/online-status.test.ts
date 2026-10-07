import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOnlineStatus } from '@/hooks/use-online-status'

const mocks = vi.hoisted(() => ({
    platform: { OS: 'android' },
    network: { isConnected: true, isInternetReachable: true },
    read: vi.fn(),
    event: null as null | ((state: { isConnected: boolean; isInternetReachable: boolean }) => void),
    foreground: null as null | ((state: string) => void),
    removeNetwork: vi.fn(),
    removeApp: vi.fn(),
}))
vi.mock('expo-network', () => ({
    useNetworkState: () => mocks.network,
    getNetworkStateAsync: mocks.read,
    addNetworkStateListener: (callback: typeof mocks.event) => {
        mocks.event = callback
        return { remove: mocks.removeNetwork }
    },
}))
vi.mock('react-native', () => ({
    Platform: mocks.platform,
    AppState: {
        currentState: 'active',
        addEventListener: (_event: string, callback: typeof mocks.foreground) => {
            mocks.foreground = callback
            return { remove: mocks.removeApp }
        },
    },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | undefined
let online: boolean
async function mount() {
    const Probe = () => { online = useOnlineStatus(); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
}
const connected = { isConnected: true, isInternetReachable: true }
const disconnected = { isConnected: false, isInternetReachable: false }

describe('online status', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mocks.platform.OS = 'android'
        mocks.network = connected
        mocks.read.mockReset().mockResolvedValue(connected)
        mocks.event = null
        mocks.foreground = null
        mocks.removeNetwork.mockClear()
        mocks.removeApp.mockClear()
    })
    afterEach(async () => {
        await act(async () => { renderer?.unmount() })
        renderer = undefined
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('rechecks a misleading online callback after the OS transition settles', async () => {
        await mount()
        expect(online).toBe(true)
        mocks.read.mockResolvedValue(disconnected)
        await act(async () => { mocks.event?.(connected); await vi.advanceTimersByTimeAsync(500) })
        expect(online).toBe(false)
        const reads = mocks.read.mock.calls.length
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
        expect(mocks.read).toHaveBeenCalledTimes(reads)
    })

    it('immediately reports either native connection loss or internet loss', async () => {
        await mount()
        await act(async () => { mocks.event?.({ isConnected: false, isInternetReachable: true }) })
        expect(online).toBe(false)
        await act(async () => { mocks.foreground?.('active') })
        expect(online).toBe(true)
        await act(async () => { mocks.event?.({ isConnected: true, isInternetReachable: false }) })
        expect(online).toBe(false)
    })

    it('corrects state on foreground even when no network event arrives', async () => {
        await mount()
        mocks.read.mockResolvedValue(disconnected)
        await act(async () => { mocks.foreground?.('active') })
        expect(online).toBe(false)
        mocks.read.mockResolvedValue(connected)
        await act(async () => { mocks.foreground?.('active') })
        expect(online).toBe(true)
    })

    it('rejects an old online read after a newer offline event', async () => {
        let resolve!: (state: typeof connected) => void
        mocks.read.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
        await mount()
        expect(online).toBe(false)
        await act(async () => { mocks.event?.(disconnected); resolve(connected) })
        expect(online).toBe(false)
    })

    it('fails closed for unknown or rejected reads and recovers on the next event', async () => {
        mocks.read.mockResolvedValueOnce({})
        await mount()
        expect(online).toBe(false)
        mocks.read.mockRejectedValueOnce(new Error('network unavailable'))
        await act(async () => { mocks.foreground?.('active') })
        expect(online).toBe(false)
        await act(async () => { mocks.event?.(connected); await vi.advanceTimersByTimeAsync(500) })
        expect(online).toBe(true)
    })

    it('cleans up both listeners and pending transition work', async () => {
        await mount()
        await act(async () => { mocks.event?.(connected); renderer?.unmount() })
        renderer = undefined
        const reads = mocks.read.mock.calls.length
        await act(async () => { await vi.advanceTimersByTimeAsync(500) })
        expect(mocks.read).toHaveBeenCalledTimes(reads)
        expect(mocks.removeNetwork).toHaveBeenCalledTimes(1)
        expect(mocks.removeApp).toHaveBeenCalledTimes(1)
    })

    it('updates web consumers from browser connectivity without native queries', async () => {
        mocks.platform.OS = 'web'
        const events = new EventTarget()
        const navigatorState = { onLine: true }
        vi.stubGlobal('window', events)
        vi.stubGlobal('navigator', navigatorState)
        await mount()
        expect(online).toBe(true)
        navigatorState.onLine = false
        await act(async () => { events.dispatchEvent(new Event('offline')) })
        expect(online).toBe(false)
        navigatorState.onLine = true
        await act(async () => { events.dispatchEvent(new Event('online')) })
        expect(online).toBe(true)
        expect(mocks.read).not.toHaveBeenCalled()
    })
})
