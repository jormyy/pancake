import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { AuthScaffold } from '@/components/auth/AuthScaffold'

const viewport = vi.hoisted(() => ({ width: 0 }))

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
    KeyboardAvoidingView: 'keyboard-view',
    ScrollView: 'scroll-view',
    Text: 'text',
    View: 'view',
    StyleSheet: { create: (value: unknown) => value },
    useWindowDimensions: () => ({ width: viewport.width, height: 900 }),
}))
vi.mock('@/components/auth/AuthHero', () => ({ AuthHero: 'auth-hero' }))
vi.mock('@/components/auth/AuthBrandMark', () => ({ AuthBrandMark: 'auth-brand' }))

async function renderAtWidth(width: number) {
    viewport.width = width
    let renderer!: ReactTestRenderer
    const props = {
        eyebrow: 'Welcome',
        title: 'Sign in',
        hero: { title: 'Your league', copy: 'Your team', proofItems: ['Draft'] },
        footer: React.createElement('a', { href: '/sign-up' }, 'Sign up'),
        children: React.createElement('input', { name: 'email' }),
    }
    await act(async () => {
        renderer = create(React.createElement(AuthScaffold, props))
    })
    const tree = renderer.toJSON()
    await act(async () => { renderer.unmount() })
    return tree
}

it.each([390, 560, 860, 1440])('keeps the server form structure when hydrating at %i pixels', async width => {
    expect(await renderAtWidth(width)).toEqual(await renderAtWidth(0))
})
