import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useOnlineStatus } from '@/hooks/use-online-status'

const network = vi.hoisted(() => ({ state: { isConnected: true, isInternetReachable: true } }))
vi.mock('expo-network', () => ({ useNetworkState: () => network.state }))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('online status', () => {
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
})
