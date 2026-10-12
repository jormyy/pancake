import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

type TestEvent = {
    data?: { json: () => unknown; text: () => string }
    notification?: { close: () => void; data: { url: string } }
    waitUntil: (promise: Promise<unknown>) => void
}

function worker() {
    const listeners = new Map<string, (event: TestEvent) => void>()
    const showNotification = vi.fn(async () => undefined)
    const postMessage = vi.fn()
    const client = { url: 'https://app.test/', focus: vi.fn(async () => undefined), postMessage }
    const self = {
        addEventListener: (name: string, listener: (event: TestEvent) => void) => listeners.set(name, listener),
        registration: { showNotification },
        location: { origin: 'https://app.test' },
        clients: { matchAll: async () => [client], openWindow: vi.fn() },
    }
    new Function('self', readFileSync('public/sw.js', 'utf8'))(self)
    return { showNotification, postMessage, async dispatch(name: string, event: Omit<TestEvent, 'waitUntil'>) {
        const pending: Promise<unknown>[] = []
        listeners.get(name)!({ ...event, waitUntil: (promise) => pending.push(promise) })
        await Promise.all(pending)
    } }
}

it('hides queued old-account payloads without requiring a page or durable account storage', async () => {
    const sw = worker()
    await sw.dispatch('push', { data: {
        json: () => ({ title: 'Private trade for A', body: 'Account A details', url: '/trades?secret=a', data: { userId: 'a' } }),
        text: () => 'Account A details',
    } })
    expect(sw.showNotification).toHaveBeenCalledWith('Pancake', {
        body: 'Open Pancake to check for updates.', icon: '/pwa-192.png', badge: '/pwa-192.png', data: { url: '/' },
    })
    expect(JSON.stringify(sw.showNotification.mock.calls)).not.toContain('Account A')
})

it('keeps malformed payload text private and still displays a visible notification', async () => {
    const sw = worker()
    await sw.dispatch('push', { data: { json: () => { throw new Error('invalid') }, text: () => 'Private account text' } })
    expect(sw.showNotification).toHaveBeenCalledOnce()
    expect(JSON.stringify(sw.showNotification.mock.calls)).not.toContain('Private account text')
})

it('opens the current account home for a notification queued before an account switch', async () => {
    const sw = worker()
    const close = vi.fn()
    await sw.dispatch('notificationclick', { notification: { close, data: { url: '/trades?secret=a' } } })
    expect(close).toHaveBeenCalledOnce()
    expect(sw.postMessage).toHaveBeenCalledWith({ type: 'PANCAKE_NOTIFICATION_CLICK', url: '/' })
})
