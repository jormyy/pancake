import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ScreenErrorFallback } from '@/components/ScreenErrorFallback'

vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('screen error fallback', () => {
    it('renders the shared empty state whose Try again action invokes the route retry', async () => {
        vi.stubGlobal('__DEV__', false)
        const retry = vi.fn(async () => undefined)
        let renderer!: ReactTestRenderer
        try {
            await act(async () => {
                renderer = create(React.createElement(ScreenErrorFallback, { error: new Error('boom'), retry }))
            })
            const state = renderer.root.findByType('EmptyState' as React.ElementType)

            expect(state.props).toMatchObject({ message: 'Something went wrong', actionLabel: 'Try again' })
            expect(state.props.description).not.toContain('boom')
            await act(async () => { state.props.onAction(); await Promise.resolve() })
            expect(retry).toHaveBeenCalledOnce()
        } finally {
            await act(async () => { renderer?.unmount() })
            vi.unstubAllGlobals()
        }
    })

    it('appends the error message only in development', async () => {
        vi.stubGlobal('__DEV__', true)
        let renderer!: ReactTestRenderer
        try {
            await act(async () => {
                renderer = create(React.createElement(ScreenErrorFallback, { error: new Error('boom'), retry: vi.fn(async () => undefined) }))
            })
            expect(renderer.root.findByType('EmptyState' as React.ElementType).props.description).toContain('boom')
        } finally {
            await act(async () => { renderer?.unmount() })
            vi.unstubAllGlobals()
        }
    })
})
