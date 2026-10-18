import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useWebPushNotifications } from '@/hooks/use-web-push-notifications'

const sync = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/web-push', () => ({ syncWebPushSubscription: sync }))
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'local-owner' } }) }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }))

let mounted: ReactTestRenderer | undefined
afterEach(async () => {
    if (mounted) await act(async () => mounted!.unmount())
    mounted = undefined
    vi.unstubAllGlobals()
    sync.mockReset().mockResolvedValue(undefined)
})

it('reconciles rotated subscriptions on worker messages and reconnect, then removes listeners', async () => {
    const window = new EventTarget()
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const serviceWorker = new EventTarget()
    const navigator = { onLine: true, serviceWorker }
    vi.stubGlobal('window', window)
    vi.stubGlobal('document', document)
    vi.stubGlobal('navigator', navigator)
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    function Probe() { useWebPushNotifications(); return null }
    await act(async () => { mounted = create(createElement(Probe)) })
    expect(sync).toHaveBeenCalledTimes(1)
    await act(async () => { serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' } })) })
    expect(sync).toHaveBeenCalledTimes(2)
    navigator.onLine = false
    await act(async () => { serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' } })) })
    expect(sync).toHaveBeenCalledTimes(2)
    navigator.onLine = true
    await act(async () => { window.dispatchEvent(new Event('online')) })
    expect(sync).toHaveBeenCalledTimes(3)
    await act(async () => mounted!.unmount())
    mounted = undefined
    window.dispatchEvent(new Event('online'))
    expect(sync).toHaveBeenCalledTimes(3)
})
