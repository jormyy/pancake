import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh'

const platform = vi.hoisted(() => ({ os: 'web' }))
vi.mock('react-native', () => ({ Platform: { get OS() { return platform.os } } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let latest: ReturnType<typeof usePullToRefresh>
const refresh = vi.fn<() => Promise<void>>()
const scrolled = vi.fn()
const Probe = ({ refreshing = false }: { refreshing?: boolean }) => { latest = usePullToRefresh(refresh, refreshing, scrolled); return null }
const touch = (x: number, y: number, fingers = 1) => ({ nativeEvent: { touches: Array.from({ length: fingers }, () => ({ pageX: x, pageY: y })) } })
const scroll = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y } } }) as Parameters<typeof latest.onScroll>[0]
const pull = async (x = 100, y = 210, fingers = 1) => act(async () => {
    latest.onTouchStart(touch(100, 100))
    latest.onTouchMove(touch(x, y, fingers))
    latest.onTouchEnd()
})
beforeEach(async () => {
    platform.os = 'web'
    refresh.mockReset().mockResolvedValue(undefined)
    scrolled.mockClear()
    await act(async () => { screen = create(React.createElement(Probe)) })
})
afterEach(async () => { await act(async () => screen.unmount()) })

it('refreshes once for a downward web pull and preserves the scroll callback', async () => {
    const event = scroll(0)
    latest.onScroll(event)
    await pull()
    expect(refresh).toHaveBeenCalledOnce()
    expect(scrolled).toHaveBeenCalledExactlyOnceWith(event)
})

it('requires the gesture to start at the top', async () => {
    latest.onScroll(scroll(40))
    await pull()
    expect(refresh).not.toHaveBeenCalled()
    latest.onScroll(scroll(0))
    await pull()
    expect(refresh).toHaveBeenCalledOnce()
})

it.each([
    { x: 100, y: 130, fingers: 1 },
    { x: 180, y: 210, fingers: 1 },
    { x: 100, y: 210, fingers: 2 },
])('ignores short, sideways, and multi-touch gestures: %j', async ({ x, y, fingers }) => {
    await pull(x, y, fingers)
    expect(refresh).not.toHaveBeenCalled()
})

it('ignores cancelled gestures and native touch gestures', async () => {
    latest.onTouchStart(touch(100, 100))
    latest.onTouchMove(touch(100, 210))
    latest.onTouchCancel()
    latest.onTouchEnd()
    platform.os = 'ios'
    await pull()
    expect(refresh).not.toHaveBeenCalled()
})

it('prevents overlapping pulls and allows another pull when the request completes', async () => {
    let finish!: () => void
    refresh.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await pull()
    await pull()
    expect(refresh).toHaveBeenCalledOnce()
    await act(async () => { finish() })
    await pull()
    expect(refresh).toHaveBeenCalledTimes(2)
    await act(async () => screen.update(React.createElement(Probe, { refreshing: true })))
    await pull()
    expect(refresh).toHaveBeenCalledTimes(2)
})
