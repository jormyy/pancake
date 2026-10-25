import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useWebPushNotifications } from '@/hooks/use-web-push-notifications'

const route = vi.hoisted(() => ({ push: vi.fn(), dismissTo: vi.fn() }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))
vi.mock('expo-router', () => ({ useRouter: () => route }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('@/lib/web-push', () => ({ syncWebPushSubscription: vi.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('returns notification taps to the existing tab tree', async () => {
    const worker = new EventTarget()
    vi.stubGlobal('navigator', { serviceWorker: worker })
    let screen!: ReactTestRenderer
    const Probe = () => { useWebPushNotifications(); return null }
    try {
        await act(async () => { screen = create(React.createElement(Probe)) })
        await act(async () => { worker.dispatchEvent(new MessageEvent('message', { data: { type: 'PANCAKE_NOTIFICATION_CLICK', url: '/trades?tradeId=offer' } })) })
        expect(route.dismissTo).toHaveBeenCalledExactlyOnceWith('/trades?tradeId=offer')
        expect(route.push).not.toHaveBeenCalled()
    } finally { await act(async () => screen.unmount()); vi.unstubAllGlobals() }
})
