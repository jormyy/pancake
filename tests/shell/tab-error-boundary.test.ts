import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import * as TabsLayout from '@/app/(tabs)/_layout'

vi.mock('@/components/navigation/WebTabShell', () => ({ default: () => null }))
vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer

afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('offers a document reload when a lazy tab cannot load', async () => {
    const reload = vi.fn()
    const retry = vi.fn(async () => {})
    vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload } }))
    const Boundary = (TabsLayout as { ErrorBoundary?: React.ComponentType<{ error: Error; retry: () => Promise<void> }> }).ErrorBoundary
    expect(Boundary).toEqual(expect.any(Function))
    await act(async () => { screen = create(React.createElement(Boundary!, { error: new Error('Loading module 42 failed'), retry })) })
    const fallback = screen.root.findByType('EmptyState' as React.ElementType)
    expect(fallback.props.actionLabel).toBe('Reload')
    await act(async () => fallback.props.onAction())
    expect(reload).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
})

it('retries the route when a document reload is unavailable', async () => {
    vi.stubGlobal('window', undefined)
    const retry = vi.fn(async () => {})
    const Boundary = (TabsLayout as { ErrorBoundary?: React.ComponentType<{ error: Error; retry: () => Promise<void> }> }).ErrorBoundary
    expect(Boundary).toEqual(expect.any(Function))
    await act(async () => { screen = create(React.createElement(Boundary!, { error: new Error('Unavailable module'), retry })) })
    await act(async () => screen.root.findByType('EmptyState' as React.ElementType).props.onAction())
    expect(retry).toHaveBeenCalledOnce()
})
