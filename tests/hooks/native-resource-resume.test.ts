import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

const native = vi.hoisted(() => ({
    focused: true,
    state: 'active',
    listeners: new Set<(state: string) => void>(),
}))
vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    AppState: {
        get currentState() { return native.state },
        addEventListener: (_event: string, callback: (state: string) => void) => {
            native.listeners.add(callback)
            return { remove: () => native.listeners.delete(callback) }
        },
    },
}))
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: () => (() => void) | void) => {
        const focused = native.focused
        React.useEffect(() => focused ? callback() : undefined, [callback, focused])
    },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | undefined
let latest: ReturnType<typeof useFocusAsyncData<string>>
let server = 'saved'
const fetcher = vi.fn(async () => server)
function Probe({ online, owner = 'a' }: { online: boolean; owner?: string }) {
    latest = useFocusAsyncData(fetcher, [owner], { online, staleMs: 300_000 })
    return null
}
async function render(online: boolean, owner = 'a') {
    await act(async () => {
        if (renderer) renderer.update(React.createElement(Probe, { online, owner }))
        else renderer = create(React.createElement(Probe, { online, owner }))
    })
}
async function advance(ms = 400) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function appState(state: string) {
    await act(async () => {
        native.state = state
        native.listeners.forEach((callback) => callback(state))
    })
}
beforeEach(() => {
    vi.useFakeTimers()
    native.focused = true
    native.state = 'active'
    native.listeners.clear()
    server = 'saved'
    fetcher.mockReset().mockImplementation(async () => server)
})
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    renderer = undefined
    vi.useRealTimers()
})

describe('native focused resource resumption', () => {
    it('keeps saved content marked as a snapshot until reconnect validation finishes', async () => {
        await render(true)
        expect(latest.isSnapshot).toBe(false)
        await render(false)
        await render(true)
        expect(latest.data).toBe('saved')
        expect(latest.isSnapshot).toBe(true)
        await advance()
        expect(latest.isSnapshot).toBe(false)
    })
    it('automatically replaces warm data once after rapid reconnect events', async () => {
        await render(true)
        expect(latest.data).toBe('saved')
        await render(false)
        server = 'fresh'
        await render(true)
        await advance(100)
        await render(false)
        await render(true)
        await advance()
        expect(latest.data).toBe('fresh')
        expect(fetcher).toHaveBeenCalledTimes(2)
        await advance(10_000)
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
    it('holds a reconnect while backgrounded and refreshes once on foreground', async () => {
        await render(true)
        await appState('background')
        await render(false)
        server = 'fresh'
        await render(true)
        await advance()
        expect(fetcher).toHaveBeenCalledTimes(1)
        await appState('active')
        await advance()
        expect(latest.data).toBe('fresh')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
    it('keeps the foreground freshness budget and refreshes stale data', async () => {
        await render(true)
        await appState('background')
        await appState('active')
        await advance()
        expect(fetcher).toHaveBeenCalledTimes(1)
        await appState('background')
        server = 'fresh'
        await advance(300_001)
        await appState('active')
        await advance()
        expect(latest.data).toBe('fresh')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
    it('defers hidden-screen reconnect until focus without background reads', async () => {
        await render(true)
        native.focused = false
        await render(false)
        server = 'fresh'
        await render(true)
        await advance()
        expect(fetcher).toHaveBeenCalledTimes(1)
        native.focused = true
        await render(true)
        await advance()
        expect(latest.data).toBe('fresh')
        expect(fetcher).toHaveBeenCalledTimes(2)
    })
    it('cancels deferred work and removes listeners on unmount', async () => {
        await render(true)
        await render(false)
        await render(true)
        await act(async () => { renderer?.unmount() })
        renderer = undefined
        expect(native.listeners.size).toBe(0)
        await advance()
        expect(fetcher).toHaveBeenCalledTimes(1)
    })
    it('drops a late response after identity changes during reconnect', async () => {
        await render(true)
        let resolve!: (value: string) => void
        fetcher.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done }))
        await render(false)
        await render(true)
        await advance()
        server = 'owner-b'
        await render(true, 'b')
        await act(async () => { resolve('owner-a-late') })
        expect(latest.data).toBe('owner-b')
    })
})
