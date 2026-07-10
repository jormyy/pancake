import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ScreenErrorFallback } from '@/components/ScreenErrorFallback'

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles },
    Text: 'Text',
    View: 'View',
}))
vi.mock('@/constants/tokens', () => ({
    colors: { bgScreen: '#fff', primary: '#000', textMuted: '#555', textPrimary: '#111', textSecondary: '#333', textWhite: '#fff' },
    fontFamily: { display: 'display' },
    fontSize: { xs: 10, sm: 12, md: 14, xl: 20 },
    fontWeight: { bold: '700' },
    radii: { md: 4 },
    spacing: { sm: 8, md: 12, xl: 24 },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.stubGlobal('__DEV__', false)

describe('screen error fallback', () => {
    it('renders a 44px recovery target that invokes the route retry', async () => {
        const retry = vi.fn(async () => undefined)
        let renderer!: ReactTestRenderer
        await act(async () => {
            renderer = create(React.createElement(ScreenErrorFallback, {
                error: new Error('boom'),
                retry,
            }))
        })
        const recoveryAction = renderer.root.findByProps({ accessibilityLabel: 'Try again' })

        expect(recoveryAction.props.style).toMatchObject({ minHeight: 44 })
        await act(async () => { recoveryAction.props.onPress(); await Promise.resolve() })
        expect(retry).toHaveBeenCalledOnce()
        await act(async () => { renderer.unmount() })
    })
})
