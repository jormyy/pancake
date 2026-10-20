import React, { Suspense, lazy } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AuthHydrationFrame, useAuthRouteReady } from '@/components/auth/AuthHydrationFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
let documentPresent: boolean
const remove = vi.fn(() => { documentPresent = false })

beforeEach(() => {
    documentPresent = true
    remove.mockClear()
    vi.stubGlobal('document', { getElementById: () => documentPresent ? { remove } : null })
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })

it.each(['sign-in', 'sign-up'])('keeps the document form until the lazy %s route mounts', async route => {
    let finish!: (module: { default: React.ComponentType }) => void
    const Route = lazy(() => new Promise<{ default: React.ComponentType }>(resolve => { finish = resolve }))
    function ReadyForm() {
        useAuthRouteReady()
        return React.createElement('input', { name: 'email' })
    }
    await act(async () => {
        screen = create(React.createElement(AuthHydrationFrame, { route },
            React.createElement(Suspense, { fallback: null }, React.createElement(Route))))
    })
    expect(documentPresent).toBe(true)
    expect(remove).not.toHaveBeenCalled()
    expect(screen.root.findByProps({ 'aria-busy': true }).findAllByType('div').at(-1)?.props.style.visibility).toBe('hidden')
    expect(screen.root.findAllByType('input')).toHaveLength(0)
    await act(async () => { finish({ default: ReadyForm }) })
    expect(documentPresent).toBe(false)
    expect(remove).toHaveBeenCalledOnce()
    expect(screen.root.findByProps({ 'aria-busy': false }).findAllByType('div').at(-1)?.props.style.visibility).toBeUndefined()
    expect(screen.root.findAllByType('input')).toHaveLength(1)
})

it('leaves a non-auth route visible from its first render', async () => {
    await act(async () => {
        screen = create(React.createElement(AuthHydrationFrame, { route: null }, React.createElement('main')))
    })
    expect(remove).not.toHaveBeenCalled()
    expect(screen.root.findAllByProps({ inert: true })).toHaveLength(0)
    expect(screen.root.findByType('main').parent?.props.style.visibility).toBeUndefined()
})

it('keeps client-rendered auth routes visible when cached Home has no document form', async () => {
    documentPresent = false
    await act(async () => {
        screen = create(React.createElement(AuthHydrationFrame, { route: 'sign-in' }, React.createElement('input')))
    })
    expect(screen.root.findByProps({ 'aria-busy': false })).toBeDefined()
    expect(screen.root.findByType('input').parent?.props.style.visibility).toBeUndefined()
})
