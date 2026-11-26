import React from 'react'
import Module from 'node:module'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebAppShell } from '@/components/navigation/WebTabShell'

const state = vi.hoisted(() => {
    const current = { id: 'member-1', team_name: 'Team One', leagues: { id: 'league-1', name: 'Sunday Dynasty' } }
    return { pathname: '/', params: {} as { tradeId?: string }, current, memberships: [current] }
})

vi.mock('react-dom', () => ({ createPortal: (children: React.ReactNode) => children }))
vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
    Platform: { OS: 'web' }, StyleSheet: { create: (value: unknown) => value, flatten: (value: unknown) => value },
    useWindowDimensions: () => ({ width: 402, height: 874 }),
}))
vi.mock('@expo/vector-icons/MaterialIcons', () => ({ default: 'MaterialIcons' }))
vi.mock('@react-navigation/native', () => ({ StackRouter: vi.fn() }))
vi.mock('expo-router', () => ({
    usePathname: () => state.pathname, useGlobalSearchParams: () => state.params,
    useRouter: () => ({ push: vi.fn(), navigate: vi.fn(), dismissTo: vi.fn() }), Link: 'Link', Navigator: 'Navigator',
}))
vi.mock('@/contexts/league-context', () => ({ useLeagueContext: () => ({
    current: state.current, memberships: state.memberships, setCurrent: vi.fn(), currentLeague: state.current.leagues,
    membershipStatus: 'ready', isCommissioner: false,
}) }))
vi.mock('@/hooks/use-pending-trade-count', () => ({ usePendingTradeCount: () => 0 }))
vi.mock('@/hooks/use-boot-shell-handoff', () => ({ useBootShellHandoff: vi.fn() }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer
const render = async () => {
    await act(async () => { screen = create(React.createElement(WebAppShell, {}, React.createElement('Content'))) })
}
const pressables = (label: string) => screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityLabel === label)
const main = () => screen.root.find(node => node.type === ('View' as React.ElementType) && node.props.role === 'main')
const mainStyle = () => Object.assign({}, ...[main().props.style].flat(Infinity).filter(Boolean))

beforeEach(() => {
    state.pathname = '/'
    state.params = {}
    const moduleLoader = Module as typeof Module & { _load: (name: string, ...args: unknown[]) => unknown }
    const originalLoad = moduleLoader._load
    vi.spyOn(moduleLoader, '_load').mockImplementation((name, ...args) => name === '@/assets/images/pancake_logo.png'
        ? 1 : originalLoad.call(moduleLoader, name, ...args))
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks() })

it.each([
    '/player/123', '/lineup', '/propose-trade', '/claim-player', '/team-roster', '/profile', '/notification-settings',
    '/change-password', '/commissioner-settings', '/draft', '/bracket', '/timeline', '/rookie-draft-room',
])('keeps the Pancake top bar above the page header on %s', async pathname => {
    state.pathname = pathname
    await render()
    expect(pressables('Open menu')).toHaveLength(1)
    expect(screen.root.findAll(node => node.props.testID === 'back-header-inset')).toHaveLength(0)
    expect(mainStyle().paddingTop).toBe('var(--pancake-mobile-topbar-height, calc(56px + env(safe-area-inset-top, 0px)))')
    expect(screen.root.findAll(node => node.type === ('Pressable' as React.ElementType) && node.props.accessibilityRole === 'link')).toHaveLength(5)
})

it('keeps the top bar on a trade opened from Trades', async () => {
    state.pathname = '/trades'
    state.params = { tradeId: 'incoming-trade' }
    await render()
    expect(pressables('Open menu')).toHaveLength(1)
    expect(mainStyle().paddingTop).toContain('--pancake-mobile-topbar-height')
})

it('gives every route the same top padding for the top bar', async () => {
    await render()
    const tabPadding = mainStyle().paddingTop
    for (const pathname of ['/players', '/player/123', '/league', '/profile']) {
        state.pathname = pathname
        await act(async () => { screen.update(React.createElement(WebAppShell, {}, React.createElement('Content'))) })
        expect(mainStyle().paddingTop).toBe(tabPadding)
    }
})
