import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOnlineStatus } from '@/hooks/use-online-status'

const { network, platform } = vi.hoisted(() => ({
    network: { state: { isConnected: true, isInternetReachable: true } },
    platform: { OS: 'ios' },
}))
vi.mock('expo-network', () => ({ useNetworkState: () => network.state }))
vi.mock('react-native', () => ({ Platform: platform }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('online status', () => {
    afterEach(() => {
        platform.OS = 'ios'
        network.state = { isConnected: true, isInternetReachable: true }
        vi.unstubAllGlobals()
    })

    it('reports native connection loss and internet loss', async () => {
        const snapshots: boolean[] = []
        const Probe = ({ tick }: { tick: number }) => {
            snapshots.push(useOnlineStatus())
            return React.createElement('probe', { tick })
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { tick: 0 })) })
        network.state = { isConnected: false, isInternetReachable: true }
        await act(async () => { renderer.update(React.createElement(Probe, { tick: 1 })) })
        network.state = { isConnected: true, isInternetReachable: false }
        await act(async () => { renderer.update(React.createElement(Probe, { tick: 2 })) })

        expect(snapshots).toEqual([true, false, false])
        await act(async () => { renderer.unmount() })
    })

    it('updates web consumers when the browser reconnects', async () => {
        platform.OS = 'web'
        const browserEvents = new EventTarget()
        const navigatorState = { onLine: true }
        vi.stubGlobal('window', browserEvents)
        vi.stubGlobal('navigator', navigatorState)
        const snapshots: boolean[] = []
        const Probe = () => {
            snapshots.push(useOnlineStatus())
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        network.state = { isConnected: false, isInternetReachable: false }
        navigatorState.onLine = false
        await act(async () => { browserEvents.dispatchEvent(new Event('offline')) })
        navigatorState.onLine = true
        await act(async () => { browserEvents.dispatchEvent(new Event('online')) })

        expect(snapshots).toEqual([true, false, true])
        await act(async () => { renderer.unmount() })
    })
})
