import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { LoadingState } from '@/components/ui/LoadingState'

const state = vi.hoisted(() => ({ generation: 1 }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', StyleSheet: { create: (value: unknown) => value } }))
vi.mock('@/lib/session-cache-registry', () => ({ sessionGeneration: () => state.generation }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
beforeEach(() => { state.generation = 1 })
afterEach(async () => { await act(async () => screen?.unmount()); vi.useRealTimers() })
const content = (ready: boolean, name: string) => React.createElement(DeferredContent, { ready }, React.createElement('row', { name }))
it('keeps revealed rows through ten pending view changes, then replaces them with the settled answer', async () => {
    await act(async () => { screen = create(content(true, 'day-one')) })
    for (let index = 0; index < 10; index += 1) {
        await act(async () => screen.update(content(false, 'pending-day')))
        expect(screen.root.findByType('row' as React.ElementType).props.name).toBe(index === 0 ? 'day-one' : `day-${index}`)
        const region = screen.root.findByType('View' as React.ElementType)
        expect(region.props['aria-busy']).toBe(true)
        expect(region.props.pointerEvents).toBe('none')
        expect(region.props.inert).toBe(true)
        await act(async () => screen.update(content(true, `day-${index + 1}`)))
        expect(screen.root.findByType('row' as React.ElementType).props.name).toBe(`day-${index + 1}`)
    }
    await act(async () => screen.update(React.createElement(DeferredContent, { ready: true }, React.createElement('empty'))))
    expect(screen.root.findAllByType('row' as React.ElementType)).toHaveLength(0)
    expect(screen.root.findAllByType('empty' as React.ElementType)).toHaveLength(1)
})
it('keeps the first-load frame busy without fabricated rows, text, animation, or a spinner', async () => {
    vi.useFakeTimers()
    await act(async () => { screen = create(React.createElement(LoadingState)) })
    const before = screen.toJSON()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.toJSON()).toEqual(before)
    const region = screen.root.findByType('View' as React.ElementType)
    expect(region.props.accessibilityState).toEqual({ busy: true })
    expect(region.props.children).toBeUndefined()
    expect(region.props.style).toContainEqual(expect.objectContaining({ flex: 1, minHeight: 320 }))
})
it('drops retained rows when the signed-in session changes', async () => {
    await act(async () => { screen = create(content(true, 'private')) })
    state.generation += 1
    await act(async () => screen.update(content(false, 'new-owner')))
    expect(screen.root.findAllByType('row' as React.ElementType)).toHaveLength(0)
})
