import React, { useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useScrollRestoration } from '@/lib/scroll-restoration'
import { clearSessionCaches } from '@/lib/session-cache-registry'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

const state = vi.hoisted(() => ({ focused: true, scrollTo: vi.fn(), scrollToOffset: vi.fn() }))
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => state.focused }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let handlers: ReturnType<typeof useScrollRestoration>
let screen: ReactTestRenderer | undefined
function List({ scope, flash = false }: { scope: string; flash?: boolean }) {
    const ref = useRef(flash ? { scrollToOffset: state.scrollToOffset } : { scrollTo: state.scrollTo })
    handlers = useScrollRestoration(scope, ref)
    return null
}
const scroll = (y: number) => handlers.onScroll({ nativeEvent: { contentOffset: { y } } } as NativeSyntheticEvent<NativeScrollEvent>)
const layout = () => handlers.onLayout({ nativeEvent: { layout: { height: 400 } } } as LayoutChangeEvent)
const render = async (scope = 'home', flash = false) => act(async () => {
    if (screen) screen.update(React.createElement(List, { scope, flash }))
    else screen = create(React.createElement(List, { scope, flash }))
})
beforeEach(() => { clearSessionCaches(); vi.clearAllMocks(); state.focused = true })
afterEach(async () => { await act(async () => screen?.unmount()); screen = undefined })

it.each(['home', 'roster', 'players'])('restores %s to 240 after a player visit and waits for content', async scope => {
    const flash = scope === 'players'
    await render(scope, flash)
    scroll(240)
    await act(async () => screen?.unmount())
    screen = undefined
    await render(scope, flash)
    layout()
    handlers.onContentSizeChange(390, 500)
    scroll(0)
    expect(state.scrollTo).not.toHaveBeenCalled()
    expect(state.scrollToOffset).not.toHaveBeenCalled()
    handlers.onContentSizeChange(390, 1000)
    const restore = flash ? state.scrollToOffset : state.scrollTo
    expect(restore).toHaveBeenCalledExactlyOnceWith(flash ? { offset: 240, animated: false } : { y: 240, animated: false })
    handlers.onContentSizeChange(390, 1200)
    expect(restore).toHaveBeenCalledOnce()
    scroll(0)
    state.focused = false
    await render(scope, flash)
    state.focused = true
    await render(scope, flash)
    expect(restore).toHaveBeenLastCalledWith(flash ? { offset: 0, animated: false } : { y: 0, animated: false })
})

it('ignores hidden scroll resets and restores when a retained list regains focus', async () => {
    await render()
    layout()
    handlers.onContentSizeChange(390, 1000)
    scroll(240)
    state.focused = false
    await render()
    scroll(0)
    state.focused = true
    await render()
    expect(state.scrollTo).toHaveBeenLastCalledWith({ y: 240, animated: false })
})

it('isolates dates, filters, teams and signed-in accounts', async () => {
    await render('user-a:team-a:day-a')
    scroll(240)
    await render('user-a:team-a:day-b')
    layout()
    handlers.onContentSizeChange(390, 1000)
    expect(state.scrollTo).not.toHaveBeenCalled()
    scroll(80)
    await render('user-a:team-a:day-a')
    expect(state.scrollTo).toHaveBeenLastCalledWith({ y: 240, animated: false })
    clearSessionCaches()
    await act(async () => screen?.unmount())
    screen = undefined
    state.scrollTo.mockClear()
    await render('user-a:team-a:day-a')
    layout()
    handlers.onContentSizeChange(390, 1000)
    expect(state.scrollTo).not.toHaveBeenCalled()
})
