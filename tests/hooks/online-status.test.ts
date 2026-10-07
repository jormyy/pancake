import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOnlineStatus } from '@/hooks/use-online-status'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
let online: boolean
async function mount() {
    const Probe = () => { online = useOnlineStatus(); return null }
    await act(async () => { renderer = create(React.createElement(Probe)) })
}
afterEach(async () => {
    await act(async () => { renderer?.unmount() })
    renderer = undefined
    vi.unstubAllGlobals()
})
describe('browser online status', () => {
    it('updates web consumers from browser connectivity without native queries', async () => {
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
    })
})
