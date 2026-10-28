import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import ModalsLayout from '@/app/(modals)/_layout'

vi.mock('@/components/EmptyState', () => ({ EmptyState: 'EmptyState' }))
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, StyleSheet: { create: (styles: unknown) => styles } }))
vi.mock('expo-router', () => ({ Stack: Object.assign((props: React.PropsWithChildren) => React.createElement('Stack', props), { Screen: 'Screen' }) }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
afterEach(async () => { await act(async () => screen?.unmount()) })

it('renders the base modal routes as pages inside the persistent shell', async () => {
    await act(async () => { screen = create(React.createElement(ModalsLayout)) })
    const options = screen.root.findByType('Stack' as React.ElementType).props.screenOptions
    expect(options).toMatchObject({ presentation: 'card', animation: 'fade', headerShadowVisible: false })
    const routes = screen.root.findAllByType('Screen' as React.ElementType)
    expect(routes.map(route => route.props.name)).toEqual([
        'create-league', 'join-league', 'commissioner-settings', 'change-password', 'draft-room',
        'rookie-draft-room', 'lineup', 'propose-trade', 'claim-player', 'bracket', 'notification-settings', 'timeline', 'matchup', 'team-roster',
    ])
    expect(routes.every(route => route.props.options.presentation === undefined)).toBe(true)
    expect(routes.find(route => route.props.name === 'draft-room')?.props.options.headerShown).toBe(false)
})
