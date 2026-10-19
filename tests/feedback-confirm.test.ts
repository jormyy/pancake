import React from 'react'
import { jsx } from 'react/jsx-runtime'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeedbackProvider, feedbackBridge } from '@/components/ui/feedback'

const environment = vi.hoisted(() => ({ reduced: false, platform: 'web' }))
vi.mock('react-native', () => ({
    Animated: { View: 'AnimatedView' }, Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View',
    Platform: { get OS() { return environment.platform } },
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ width: 390 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'Icon' }))
vi.mock('@/components/Motion', () => ({ useReducedMotion: () => environment.reduced }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }))
vi.mock('@/components/ui/Button', () => ({ Button: 'Button' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let renderer: ReactTestRenderer | undefined
const modal = () => renderer!.root.findAllByType('Modal' as React.ElementType)[0]
const press = (title: string) => renderer!.root.findAllByType('Button' as React.ElementType)
    .find(button => button.props.title === title)!.props.onPress()
const mount = async () => { await act(async () => { renderer = create(jsx(FeedbackProvider, { children: null })) }) }
const request = async (title = 'First') => {
    let promise!: Promise<boolean>
    await act(async () => { promise = feedbackBridge.api!.confirm({ title }) })
    return { promise }
}

beforeEach(() => { environment.reduced = false; environment.platform = 'web' })
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

describe('confirmation dismissal', () => {
    it.each([true, false])('settles %s only after the animated web dialog unmounts', async result => {
        await mount()
        const { promise } = await request()
        const settled = vi.fn(() => expect(modal()).toBeUndefined())
        void promise.then(settled)
        expect(modal().props.animationType).toBe('slide')
        await act(async () => { press(result ? 'Confirm' : 'Cancel') })
        expect(settled).not.toHaveBeenCalled()
        expect(modal().props.visible).toBe(false)
        expect(renderer!.root.findAllByType('Text' as React.ElementType)[0].props.children).toBe('First')
        await act(async () => { modal().props.onDismiss() })
        expect(settled).toHaveBeenCalledWith(result)
    })

    it('queues overlapping requests and ignores repeated close events', async () => {
        await mount()
        const first = await request('First')
        const second = await request('Second')
        const settled: boolean[] = []
        void first.promise.then(value => { settled.push(value) })
        void second.promise.then(value => { settled.push(value) })
        expect(renderer!.root.findAllByType('Text' as React.ElementType)[0].props.children).toBe('First')
        await act(async () => { press('Confirm'); press('Cancel') })
        expect(settled).toEqual([])
        const dismiss = modal().props.onDismiss
        await act(async () => { dismiss() })
        expect(settled).toEqual([true])
        expect(renderer!.root.findAllByType('Text' as React.ElementType)[0].props.children).toBe('Second')
        await act(async () => { dismiss(); modal().props.onRequestClose() })
        await act(async () => { modal().props.onDismiss() })
        expect(settled).toEqual([true, false])
    })

    it('cancels active and queued requests when the provider unmounts', async () => {
        await mount()
        const api = feedbackBridge.api!
        const first = await request()
        const second = await request('Second')
        const firstSettled = vi.fn()
        const secondSettled = vi.fn()
        void first.promise.then(firstSettled)
        void second.promise.then(secondSettled)
        await act(async () => { renderer!.unmount(); renderer = undefined })
        expect(firstSettled).toHaveBeenCalledWith(false)
        expect(secondSettled).toHaveBeenCalledWith(false)
        expect(feedbackBridge.api).toBeNull()
        await expect(api.confirm({ title: 'After unmount' })).resolves.toBe(false)
    })

    it('uses no animation for reduced motion and still waits for web dismissal', async () => {
        environment.reduced = true
        await mount()
        const { promise } = await request()
        const settled = vi.fn()
        void promise.then(settled)
        expect(modal().props.animationType).toBe('none')
        await act(async () => { press('Confirm') })
        expect(settled).not.toHaveBeenCalled()
        await act(async () => { modal().props.onDismiss() })
        await expect(promise).resolves.toBe(true)
    })

    it('settles native confirmations without depending on an Android onDismiss callback', async () => {
        environment.platform = 'android'
        await mount()
        const { promise } = await request()
        await act(async () => { press('Cancel') })
        await expect(promise).resolves.toBe(false)
    })
})
