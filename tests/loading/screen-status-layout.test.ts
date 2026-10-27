import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { ScreenStatusOverlay, ScreenStatusProvider, ScreenStatusScrollView, useScreenStatusScroll } from '@/components/ui/ScreenStatusOverlay'
import { Button } from '@/components/ui/Button'
import { ErrorBanner } from '@/components/ui/ErrorBanner'
import { spacing } from '@/constants/tokens'

const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean))
let viewportWidth = 390
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable',
    useWindowDimensions: () => ({ width: viewportWidth, height: 844 }),
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, flatten: (value: unknown) => flatten(value) },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let scroll: ReturnType<typeof useScreenStatusScroll>
const original = { paddingBottom: 32, paddingHorizontal: 12 }
function Probe() {
    scroll = useScreenStatusScroll()
    return React.createElement('Probe', { contentStyle: scroll.contentStyle(original), inset: scroll.paddingBottom })
}
function Frame({ visible }: { visible: boolean }) {
    return React.createElement(ScreenStatusProvider, null, [
        React.createElement(Probe, { key: 'scroll' }),
        React.createElement(ScreenStatusOverlay, { key: 'notice' }, visible ? 'Saved data · Offline' : null),
    ])
}
const render = async (visible: boolean) => act(async () => { screen = create(React.createElement(Frame, { visible })) })
const update = async (visible: boolean) => act(async () => screen.update(React.createElement(Frame, { visible })))
const scrollTo = async (offset: number) => act(async () => scroll.onScroll({ nativeEvent: { contentOffset: { y: offset }, contentSize: { height: 1500 }, layoutMeasurement: { height: 400 } } } as never))
afterEach(async () => { await act(async () => screen?.unmount()); viewportWidth = 390 })

it('reserves no band or scroll padding online and keeps an empty live region mounted', async () => {
    await render(false)
    const notice = screen.root.findByProps({ testID: 'screen-status-notice' })
    expect(flatten(notice.props.style)).toMatchObject({ position: 'absolute', bottom: 72 })
    expect(flatten(notice.props.style).height).toBeUndefined()
    expect(notice.props.pointerEvents).toBe('none')
    expect(notice.props['aria-live']).toBe('polite')
    expect(notice.props.role).toBe('status')
    expect(scroll.paddingBottom).toBe(0)
    expect(scroll.contentStyle(original)).toBe(original)
})

it('adds the measured overlay and global-notice clearance only to the scroll tail', async () => {
    await render(true)
    const measured = screen.root.findAllByType('View' as React.ElementType).find(node => node.props.onLayout)!
    await act(async () => measured.props.onLayout({ nativeEvent: { layout: { height: 56 } } }))
    expect(scroll.paddingBottom).toBe(72 + 56 + spacing.sm)
    expect(flatten(scroll.contentStyle(original))).toEqual({ paddingHorizontal: 12, paddingBottom: 32 + 72 + 56 + spacing.sm })
    await update(false)
    expect(scroll.paddingBottom).toBe(0)
    expect(scroll.contentStyle(original)).toBe(original)
})

it('retains the tail at the bottom on reconnect and releases it only after scrolling to a safe offset', async () => {
    await render(true)
    const inset = scroll.paddingBottom
    await scrollTo(1100)
    await update(false)
    expect(scroll.paddingBottom).toBe(inset)
    expect(screen.root.findByProps({ testID: 'screen-status-notice' }).props.children).toBeNull()
    await scrollTo(900)
    expect(900).toBeLessThan(1500 - 400 - inset)
    expect(scroll.paddingBottom).toBe(0)
})

it('removes the tail immediately when the existing offset does not need clamping', async () => {
    await render(true)
    await scrollTo(100)
    await update(false)
    expect(scroll.paddingBottom).toBe(0)
})

it('stacks above the desktop global notice without reserving viewport height', async () => {
    viewportWidth = 1440
    await render(true)
    const notice = screen.root.findByProps({ testID: 'screen-status-notice' })
    expect(flatten(notice.props.style)).toMatchObject({ position: 'absolute', bottom: 144 })
    expect(flatten(notice.props.style).height).toBeUndefined()
    expect(scroll.paddingBottom).toBe(144 + 44 + spacing.sm)
})

it('keeps retries and polite announcements accessible through repeated notice updates', async () => {
    const retry = vi.fn()
    await act(async () => { screen = create(React.createElement(ScreenStatusProvider, null, React.createElement(ScreenStatusOverlay, null, React.createElement(ErrorBanner, { message: 'Saved data. Tap to retry.', onRetry: retry })))) })
    const live = screen.root.findByProps({ role: 'status' })
    expect(live.props['aria-live']).toBe('polite')
    expect(live.props.accessibilityLiveRegion).toBe('polite')
    const action = screen.root.findByType('Pressable' as React.ElementType)
    expect(action.props.accessibilityLabel).toBe('Saved data. Tap to retry.')
    await act(async () => action.props.onPress())
    expect(retry).toHaveBeenCalledOnce()
})

it('leaves native scroll content styles unchanged without a screen notice', async () => {
    await act(async () => { screen = create(React.createElement(ScreenStatusScrollView, { contentContainerStyle: original })) })
    expect(screen.root.findByType('ScrollView' as React.ElementType).props.contentContainerStyle).toBe(original)
})

it('keeps the button shadow and flexible default labels on other screens', async () => {
    await act(async () => { screen = create(React.createElement(Button, { title: 'Save' })) })
    expect(flatten(screen.root.findByType('Text' as React.ElementType).props.style).width).toBeUndefined()
    const button = screen.root.findByType('Pressable' as React.ElementType)
    expect(flatten(button.props.style({ hovered: false, pressed: false })).boxShadow).toBeTruthy()
})
