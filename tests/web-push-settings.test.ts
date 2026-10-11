import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebPushSettings } from '@/components/WebPushSettings'
import { Button } from '@/components/ui'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { showAlert } from '@/lib/alert'
import { disableWebPush, enableWebPush, getWebPushStatus, sendTestWebPush } from '@/lib/web-push'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    ActivityIndicator: 'ActivityIndicator',
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text', View: 'View',
}))
vi.mock('@/components/ui', () => ({ Button: 'Button' }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn() }))
vi.mock('@/lib/web-push', () => ({
    disableWebPush: vi.fn(), enableWebPush: vi.fn(), getWebPushStatus: vi.fn(),
    getWebPushPublicKey: vi.fn(async () => 'synthetic-public-key'), sendTestWebPush: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}

async function mount(status: 'on' | 'off') {
    vi.mocked(getWebPushStatus).mockResolvedValue(status)
    const onStatusChange = vi.fn()
    let renderer!: ReactTestRenderer
    await act(async () => { renderer = create(React.createElement(WebPushSettings, { onStatusChange })) })
    const press = (title: string) => {
        const button = renderer.root.findAllByType(Button).find(node => node.props.title === title)
        expect(button).toBeDefined()
        void button!.props.onPress()
    }
    return { renderer, onStatusChange, press }
}

beforeEach(() => {
    vi.clearAllMocks()
    setSessionOwner('owner-a')
})

describe('web notification controls retain their initiating owner', () => {
    it.each(['enable', 'disable', 'test'] as const)('ignores a late %s error after an account switch', async action => {
        const pending = deferred<never>()
        const operation = action === 'enable' ? enableWebPush : action === 'disable' ? disableWebPush : sendTestWebPush
        vi.mocked(operation).mockReturnValue(pending.promise)
        const view = await mount(action === 'enable' ? 'off' : 'on')
        await act(async () => { view.press(action === 'enable' ? 'Turn on' : action === 'disable' ? 'Turn off' : 'Test') })
        setSessionOwner('owner-b')
        await act(async () => { pending.reject(new Error('Invalid or expired token')) })
        expect(showAlert).not.toHaveBeenCalled()
        await act(async () => { view.renderer.unmount() })
    })

    it('ignores a late enable error after leaving the screen', async () => {
        const pending = deferred<never>()
        vi.mocked(enableWebPush).mockReturnValue(pending.promise)
        const view = await mount('off')
        await act(async () => { view.press('Turn on') })
        await act(async () => { view.renderer.unmount() })
        await act(async () => { pending.reject(new Error('Late request failed')) })
        expect(showAlert).not.toHaveBeenCalled()
    })

    it('does not publish an old enable success to the next account', async () => {
        const pending = deferred<'on'>()
        vi.mocked(enableWebPush).mockReturnValue(pending.promise)
        const view = await mount('off')
        await act(async () => { view.press('Turn on') })
        setSessionOwner('owner-b')
        await act(async () => { pending.resolve('on') })
        expect(view.onStatusChange.mock.calls).toEqual([['off']])
        await act(async () => { view.renderer.unmount() })
    })

    it('does not show the old test recovery message or start another read for the next account', async () => {
        const pending = deferred<{ sent: number; pruned: number; failed: number }>()
        vi.mocked(sendTestWebPush).mockReturnValue(pending.promise)
        const view = await mount('on')
        await act(async () => { view.press('Test') })
        setSessionOwner('owner-b')
        await act(async () => { pending.resolve({ sent: 0, pruned: 0, failed: 0 }) })
        expect(showAlert).not.toHaveBeenCalled()
        expect(getWebPushStatus).toHaveBeenCalledTimes(1)
        await act(async () => { view.renderer.unmount() })
    })

    it('still reports a current error and allows the same owner to retry', async () => {
        vi.mocked(enableWebPush).mockRejectedValueOnce(new Error('Registration failed')).mockResolvedValueOnce('on')
        const view = await mount('off')
        await act(async () => { view.press('Turn on') })
        expect(showAlert).toHaveBeenCalledWith('Error', 'Registration failed')
        const button = view.renderer.root.findByType(Button)
        expect(button.props.loading).toBe(false)
        await act(async () => { view.press('Turn on') })
        expect(view.onStatusChange.mock.calls).toEqual([['off'], ['on']])
        await act(async () => { view.renderer.unmount() })
    })
})
