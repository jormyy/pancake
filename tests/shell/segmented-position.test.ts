import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { spacing } from '@/constants/tokens'

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, ScrollView: 'ScrollView', View: 'View', Text: 'Text', Pressable: 'Pressable',
    StyleSheet: { create: (value: unknown) => value },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let resized: ResizeObserverCallback | undefined
const disconnect = vi.fn()
afterEach(async () => {
    await act(async () => screen?.unmount())
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

function prepareTrack() {
    const track = {
        scrollLeft: 0, clientWidth: 402, scrollWidth: 800,
        getBoundingClientRect: () => ({ left: 0 }),
    }
    const selected = { getBoundingClientRect: () => ({ left: 600 - track.scrollLeft, right: 700 - track.scrollLeft }) }
    vi.stubGlobal('document', { getElementById: () => selected })
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: ResizeObserverCallback) { resized = callback }
        observe() {}
        disconnect = disconnect
    })
    return track
}

it('positions a deep-linked section before paint without waiting for native layout events', async () => {
    const track = prepareTrack()
    await act(async () => {
        screen = create(React.createElement(SegmentedControl, {
            value: 'settings', options: [{ value: 'standings', label: 'Standings' }, { value: 'settings', label: 'Settings' }],
            scrollable: true, onChange: vi.fn(),
        }), { createNodeMock: () => ({ getScrollableNode: () => track }) })
    })
    expect(track.scrollLeft).toBe(700 - 402 + spacing.xl)
})

it('positions a hidden track when it becomes visible and leaves user scrolling intact', async () => {
    const track = prepareTrack()
    track.clientWidth = 0
    await act(async () => {
        screen = create(React.createElement(SegmentedControl, {
            value: 'settings', options: [{ value: 'settings', label: 'Settings' }], scrollable: true, onChange: vi.fn(),
        }), { createNodeMock: () => ({ getScrollableNode: () => track }) })
    })
    expect(track.scrollLeft).toBe(0)
    track.clientWidth = 402
    await act(async () => { resized?.([], {} as ResizeObserver) })
    expect(track.scrollLeft).toBe(700 - 402 + spacing.xl)
    track.scrollLeft = 100
    await act(async () => { resized?.([], {} as ResizeObserver) })
    expect(track.scrollLeft).toBe(100)
    await act(async () => screen.unmount())
    expect(disconnect).toHaveBeenCalledOnce()
})
